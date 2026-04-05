// ─── Background Service Worker ────────────────────────────────────────────────
// Full autonomy mode. The AI acts on its own schedule — no approvals needed.
// You interact the minimum: drop a video, read the Telegram digest.
//
// Schedule:
//   09:00  — Morning trend scan + post ideas sent to Telegram
//   Every 60 min — Engagement cycle (comments + follows)
//   19:00  — Evening engagement push
//   22:00  — Daily digest sent to Telegram
//   8 min  — Golden hour comment replies (while active)

import { runTask, chat } from './utils/claude.js';
import {
  getConfig,
  saveCurrentTask,
  loadCurrentTask,
  clearCurrentTask,
  saveLastUrl,
  canPerformAction,
  recordFollowed,
  recordCommented,
  getDailyCounts,
  setGoldenHourPost,
  getGoldenHourPost,
  logAutonomousAction,
  addActivity,
  getActivityLog,
  getNextHashtagCluster,
} from './utils/storage.js';
import {
  notifyPostIdea,
  notifyGoldenHour,
  sendDailyDigest,
  notifyAlert,
  sendMessage,
} from './utils/telegram.js';

// ─── State ────────────────────────────────────────────────────────────────────
let activeTaskAbortController = null;
let sidePanelPort = null;

// ─── Side Panel Connection ────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidepanel') return;
  sidePanelPort = port;
  port.onDisconnect.addListener(() => { sidePanelPort = null; });

  resumeStateOnStartup().then(state => {
    if (state) sendToPanel({ type: 'resume_state', payload: state });
  });
});

function sendToPanel(msg) {
  if (sidePanelPort) try { sidePanelPort.postMessage(msg); } catch (_) {}
}

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.source !== 'iam_panel') return false;
  handlePanelMessage(message).then(sendResponse);
  return true;
});

async function handlePanelMessage({ type, payload }) {
  switch (type) {
    case 'run_task':      return await startTask(payload.task, payload.conversationHistory);
    case 'stop_task':     stopActiveTask(); return { ok: true };
    case 'get_activity':  return { ok: true, log: await getActivityLog() };
    case 'get_daily_counts': return { ok: true, counts: await getDailyCounts() };
    case 'chat':          return await handleChat(payload.prompt, payload.history);

    // Manual triggers from Tools tab
    case 'scan_hashtags':       return await runTrendScan();
    case 'run_engagement':      return await runEngagementCycle();
    case 'draft_caption':       return await handleDraftCaption(payload);
    case 'get_hashtag_cluster': return { ok: true, cluster: await getNextHashtagCluster() };
    case 'start_golden_hour':   return await startGoldenHour(payload.postUrl);

    default: return { ok: false, error: `Unknown type: ${type}` };
  }
}

// ─── Core Task Runner ─────────────────────────────────────────────────────────
async function startTask(taskDescription, conversationHistory = []) {
  stopActiveTask();

  const config = await getConfig();
  if (!config.claudeApiKey) return { ok: false, error: 'No Claude API key in Settings.' };

  await saveCurrentTask({ description: taskDescription, startedAt: Date.now() });
  sendToPanel({ type: 'task_started', payload: { description: taskDescription } });

  activeTaskAbortController = new AbortController();
  const { signal } = activeTaskAbortController;

  const result = await runTask({
    apiKey: config.claudeApiKey,
    config,
    taskDescription,
    conversationHistory,
    onStatus: status => {
      if (!signal.aborted) sendToPanel({ type: 'task_status', payload: { status } });
    },
    executeToolOnTab: async (tool, params) => {
      if (signal.aborted) return { ok: false, error: 'Task aborted' };
      return await executeToolOnInstagramTab(tool, params);
    },
  });

  if (!signal.aborted) {
    await clearCurrentTask();
    sendToPanel({ type: 'task_done', payload: result });
    parseAndLogActions(result.result || '');
  }

  return result;
}

function stopActiveTask() {
  if (activeTaskAbortController) {
    activeTaskAbortController.abort();
    activeTaskAbortController = null;
  }
  sendToPanel({ type: 'task_stopped' });
}

// ─── Parse actions from Claude's output and log them ─────────────────────────
async function parseAndLogActions(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes('AUTONOMOUS_ACTION:')) {
      const desc = line.split('AUTONOMOUS_ACTION:')[1]?.trim();
      if (!desc) continue;
      await logAutonomousAction({ description: desc });
      await addActivity({ type: inferActionType(desc), description: desc });
      sendToPanel({ type: 'activity_updated' });
    }
    if (line.includes('POST_IDEA:')) {
      const idea = line.split('POST_IDEA:')[1]?.trim();
      if (idea) await tgNotify('post_idea', { idea });
    }
  }
}

function inferActionType(desc) {
  if (desc.includes('comment'))  return 'comment';
  if (desc.includes('follow'))   return 'follow';
  if (desc.includes('like'))     return 'like';
  if (desc.includes('reply'))    return 'reply';
  if (desc.includes('dm'))       return 'dm';
  return 'action';
}

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────

// 09:00 — Scan trends, generate post ideas, notify via Telegram
async function runTrendScan() {
  const result = await startTask(
    'Scan the top posts in aviation hashtags #aviation, #planespotting, #avgeek, #aviationphotography, #aircraftspotting. ' +
    'For each hashtag page, read the top 6 posts. Identify: what aircraft types are trending, ' +
    'what content formats are getting the most engagement, any viral posts or emerging topics. ' +
    'Then generate 3 specific post ideas for my aviation video account based on what you found. ' +
    'For each post idea, write it on a new line starting with "POST_IDEA:" followed by the idea. ' +
    'End with a brief summary of today\'s trends.'
  );
  return result;
}

// Hourly + 19:00 — Comment on posts + follow relevant accounts
async function runEngagementCycle() {
  const counts = await getDailyCounts();
  const canComment = counts.comments < 10;
  const canFollow  = counts.follows  < 35;
  const canLike    = counts.likes    < 60;

  if (!canComment && !canFollow && !canLike) {
    return { ok: true, result: 'Daily limits reached. No engagement actions taken.' };
  }

  const budget = [];
  if (canComment) budget.push(`comment on up to ${10 - counts.comments} posts`);
  if (canFollow)  budget.push(`follow up to ${Math.min(8, 35 - counts.follows)} accounts`);
  if (canLike)    budget.push(`like up to ${Math.min(15, 60 - counts.likes)} posts`);

  return await startTask(
    `Run an autonomous engagement cycle for an aviation Instagram account. ` +
    `Your budget this cycle: ${budget.join(', ')}. ` +
    `\nStrategy:\n` +
    `1. Navigate to #planespotting and #avgeek explore pages.\n` +
    `2. Find posts with good content (not already commented/liked by us).\n` +
    `3. Leave specific, thoughtful comments that reference the actual aircraft, angle, or story.\n` +
    `4. Follow users who post quality aviation content and appear genuinely engaged in the community.\n` +
    `5. Like posts from accounts we follow or that align with our niche.\n` +
    `6. Add 3-5 second random delays between every action to behave naturally.\n` +
    `7. After each action, write "AUTONOMOUS_ACTION: [description]" on its own line.\n` +
    `8. At the end, write a one-paragraph summary of what you did and why.`
  );
}

// Golden hour — auto-reply to comments on latest post
async function runGoldenHourCycle() {
  const goldenHour = await getGoldenHourPost();
  if (!goldenHour) {
    chrome.alarms.clear('golden_hour_check');
    return;
  }

  const result = await startTask(
    `Navigate to ${goldenHour.url}. ` +
    `Read all comments on the post. For every comment that isn't spam or just an emoji, ` +
    `reply directly with a warm, specific response that continues the conversation. ` +
    `Post each reply immediately — no approval needed. ` +
    `After each reply, write "AUTONOMOUS_ACTION: replied to comment by @[username]". ` +
    `At the end write "REPLIES_SENT: N" where N is the total number of replies you posted.`
  );

  // Parse reply count for Telegram notification
  if (result.ok && result.result) {
    const match = result.result.match(/REPLIES_SENT:\s*(\d+)/);
    const repliesSent = match ? parseInt(match[1]) : 0;
    if (repliesSent > 0) {
      await tgNotify('golden_hour', {
        postUrl: goldenHour.url,
        commentCount: repliesSent,
        repliesSent,
      });
    }
  }
}

// 22:00 — Send daily digest to Telegram
async function sendEveningDigest() {
  const config = await getConfig();
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const counts = await getDailyCounts();
  const log    = await getActivityLog();

  // Get today's actions
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayActions = log
    .filter(e => e.executedAt >= todayStart.getTime())
    .map(e => e.description)
    .slice(0, 5);

  // Ask Claude for post ideas based on today's trend scan
  const ideasResult = await handleChat(
    'Based on current aviation trends, suggest 3 short post ideas for tomorrow. ' +
    'Return them as a numbered list, one per line, each under 20 words.'
  );
  const postIdeas = ideasResult.ok
    ? ideasResult.text.split('\n').filter(l => l.match(/^\d+\./)).map(l => l.replace(/^\d+\.\s*/, ''))
    : [];

  await sendDailyDigest({
    botToken:   config.telegramBotToken,
    chatId:     config.telegramChatId,
    counts,
    topActions: todayActions,
    postIdeas,
  });
}

// ─── Alarm Scheduler ─────────────────────────────────────────────────────────
function scheduleAlarms() {
  // Engagement: every 60 minutes
  chrome.alarms.create('engagement_cycle', { periodInMinutes: 60 });

  // Morning trend scan: 09:00 daily
  chrome.alarms.create('morning_scan', {
    when:            nextAlarmTime(9, 0),
    periodInMinutes: 24 * 60,
  });

  // Evening engagement push: 19:00 daily
  chrome.alarms.create('evening_engagement', {
    when:            nextAlarmTime(19, 0),
    periodInMinutes: 24 * 60,
  });

  // Daily digest: 22:00 daily
  chrome.alarms.create('daily_digest', {
    when:            nextAlarmTime(22, 0),
    periodInMinutes: 24 * 60,
  });
}

chrome.alarms.onAlarm.addListener(async alarm => {
  switch (alarm.name) {
    case 'engagement_cycle':  await runEngagementCycle(); break;
    case 'morning_scan':      await runTrendScan();        break;
    case 'evening_engagement':await runEngagementCycle(); break;
    case 'daily_digest':      await sendEveningDigest();   break;
    case 'golden_hour_check': await runGoldenHourCycle();  break;
  }
});

function nextAlarmTime(hour, minute) {
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

// ─── Golden Hour ──────────────────────────────────────────────────────────────
async function startGoldenHour(postUrl) {
  await setGoldenHourPost(postUrl);
  sendToPanel({ type: 'golden_hour_started', payload: { postUrl } });
  chrome.alarms.create('golden_hour_check', { periodInMinutes: 8 });
  await tgNotify('alert', {
    title: '⏱ Golden Hour Started',
    body:  `Monitoring your post and auto-replying to comments for the next 90 minutes.\n${postUrl}`,
  });
  return { ok: true };
}

// ─── Caption Drafting ─────────────────────────────────────────────────────────
async function handleDraftCaption({ videoDescription, aircraftType, location }) {
  const config  = await getConfig();
  const cluster = await getNextHashtagCluster();

  return await handleChat(
    `Draft an Instagram caption for my aviation video.\n\n` +
    `Details:\n- Video: ${videoDescription}\n` +
    `- Aircraft: ${aircraftType || 'not specified'}\n` +
    `- Location: ${location || 'not specified'}\n\n` +
    `Requirements:\n` +
    `- Punchy opening hook\n` +
    `- 2-3 sentences of engaging context (facts, story, or detail)\n` +
    `- CTA that encourages saves or shares\n` +
    `- Hashtags on a new line: ${cluster?.tags.join(' ')}\n\n` +
    `Tone: ${config.tonePreference}. Under 200 words.`
  );
}

// ─── Chat (no browser, pure Claude) ──────────────────────────────────────────
async function handleChat(prompt, history = []) {
  const config = await getConfig();
  if (!config.claudeApiKey) return { ok: false, error: 'No Claude API key in Settings.' };
  const { chat } = await import('./utils/claude.js');
  return await chat({ apiKey: config.claudeApiKey, config, prompt, conversationHistory: history });
}

// ─── Telegram Helper ──────────────────────────────────────────────────────────
async function tgNotify(type, payload) {
  const config = await getConfig();
  const { telegramBotToken: botToken, telegramChatId: chatId } = config;
  if (!botToken || !chatId) return;

  switch (type) {
    case 'post_idea':   return await notifyPostIdea({ botToken, chatId, idea: payload.idea });
    case 'golden_hour': return await notifyGoldenHour({ botToken, chatId, ...payload });
    case 'alert':       return await notifyAlert({ botToken, chatId, title: payload.title, body: payload.body });
  }
}

// ─── Tool Execution ───────────────────────────────────────────────────────────
async function executeToolOnInstagramTab(tool, params) {
  const tab = await getOrOpenInstagramTab();
  if (!tab) return { ok: false, error: 'Could not find or open Instagram tab.' };
  if (params.url) await saveLastUrl(params.url);
  if (tool === 'screenshot') return await captureTabScreenshot(tab.id);
  return await sendToContentScript(tab.id, tool, params);
}

async function sendToContentScript(tabId, tool, params) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { source: 'iam_background', tool, params }, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: 'No response from content script' });
      }
    });
  });
}

async function captureTabScreenshot(tabId) {
  return new Promise(resolve => {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 70 }, dataUrl => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve({ ok: true, data: { screenshot: dataUrl } });
      }
    });
  });
}

async function getOrOpenInstagramTab() {
  const tabs = await chrome.tabs.query({ url: '*://www.instagram.com/*' });
  if (tabs.length > 0) return tabs[0];
  const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false });
  await sleep(3000);
  return tab;
}

// ─── Resume State ─────────────────────────────────────────────────────────────
async function resumeStateOnStartup() {
  const [task, goldenHour] = await Promise.all([loadCurrentTask(), getGoldenHourPost()]);
  if (!task && !goldenHour) return null;
  return { previousTask: task, goldenHourActive: !!goldenHour };
}

// ─── Extension Install / Startup ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  scheduleAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
