// ─── Background Service Worker ────────────────────────────────────────────────
// Orchestrates Claude API calls, tool execution on the Instagram tab,
// screenshot capture, Telegram notifications, autonomous actions,
// and communication with the side panel.

import { runTask, chat } from './utils/claude.js';
import {
  getConfig,
  saveCurrentTask,
  loadCurrentTask,
  clearCurrentTask,
  saveLastUrl,
  addToActionQueue,
  getActionQueue,
  removeFromActionQueue,
  canPerformAction,
  recordFollowed,
  recordCommented,
  hasFollowed,
  hasCommented,
  getNextHashtagCluster,
  getDailyCounts,
  setGoldenHourPost,
  getGoldenHourPost,
  logAutonomousAction,
} from './utils/storage.js';
import {
  notifyApprovalNeeded,
  notifyPostIdea,
  notifyTaskComplete,
  notifyGoldenHour,
  notifyAlert,
  pollCallbackQueries,
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

function sendToPanel(message) {
  if (sidePanelPort) {
    try { sidePanelPort.postMessage(message); } catch (_) {}
  }
}

// ─── Message Router (from side panel) ────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.source !== 'iam_panel') return false;
  handlePanelMessage(message).then(sendResponse);
  return true;
});

async function handlePanelMessage(message) {
  const { type, payload } = message;

  switch (type) {
    case 'run_task':
      return await startTask(payload.task, payload.conversationHistory);

    case 'stop_task':
      stopActiveTask();
      return { ok: true };

    case 'approve_action':
      return await executeApprovedAction(payload.actionId);

    case 'reject_action':
      await removeFromActionQueue(payload.actionId);
      return { ok: true };

    case 'get_action_queue':
      return { ok: true, queue: await getActionQueue() };

    case 'get_daily_counts':
      return { ok: true, counts: await getDailyCounts() };

    case 'get_autonomous_log':
      return { ok: true, log: await import('./utils/storage.js').then(m => m.getAutonomousLog()) };

    case 'chat':
      return await handleChat(payload.prompt, payload.history);

    // Module 1: Content Intelligence
    case 'scan_hashtags':
      return await startTask(
        'Scan the top posts in aviation hashtags #aviation, #planespotting, #avgeek. ' +
        'For each hashtag, navigate to its explore page, read the top 6 posts, and summarize: ' +
        'what types of content are performing best, what aircraft/angles are trending, content gaps. ' +
        'If you find a strong post idea, end your response with "POST_IDEA: " followed by the idea.'
      );

    // Module 2: Post Optimization
    case 'draft_caption':
      return await handleDraftCaption(payload);

    case 'get_hashtag_cluster':
      return { ok: true, cluster: await getNextHashtagCluster() };

    // Module 3: Engagement
    case 'build_comment_queue':
      return await startEngagementTask('comments');

    case 'start_golden_hour':
      return await startGoldenHour(payload.postUrl);

    case 'build_follow_queue':
      return await startEngagementTask('follows');

    // Autonomous mode: AI acts on its own
    case 'run_autonomous_cycle':
      return await runAutonomousCycle();

    default:
      return { ok: false, error: `Unknown message type: ${type}` };
  }
}

// ─── Task Execution ───────────────────────────────────────────────────────────
async function startTask(taskDescription, conversationHistory = []) {
  stopActiveTask();

  const config = await getConfig();
  if (!config.claudeApiKey) {
    return { ok: false, error: 'No Claude API key set. Please add it in Settings.' };
  }

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

    // Check for post idea in result
    if (result.ok && result.result?.includes('POST_IDEA:')) {
      const idea = result.result.split('POST_IDEA:')[1]?.trim();
      if (idea) await telegramNotify('post_idea', { idea });
    }

    // Notify Telegram when task completes with meaningful output
    if (result.ok && result.result?.length > 100) {
      await telegramNotify('task_complete', { summary: result.result });
    }
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

// ─── Engagement Tasks (comments + follows) ───────────────────────────────────
async function startEngagementTask(mode) {
  const config = await getConfig();

  if (mode === 'comments') {
    const canComment = await canPerformAction('comments');
    if (!canComment) {
      return { ok: false, error: 'Daily comment limit reached (10/day).' };
    }

    if (config.autonomousMode) {
      // Autonomous: Claude finds posts and comments without approval
      return await startTask(
        'Find 5 recent posts in aviation hashtags (#planespotting, #aviation, #avgeek, #aviationphotography). ' +
        'For each post: navigate to it, read the caption and content, write a specific thoughtful comment ' +
        'that references the aircraft, angle, or story in the post. ' +
        'Post the comment directly. Add random delays of 2-4 seconds between each comment. ' +
        'After each comment, say "AUTONOMOUS_ACTION: commented on [url]". ' +
        'Stay within safe limits — maximum 5 comments this session.'
      );
    } else {
      // Manual approval mode
      return await startTask(
        'Find 8 recent posts in aviation hashtags (#planespotting, #aviation, #avgeek, #aviationphotography) ' +
        'that we haven\'t commented on yet. For each post: navigate to it, read the caption and content, ' +
        'then write a specific, thoughtful comment referencing something real in the post. ' +
        'Add each to the approval queue — do NOT post yet. Say "AWAITING APPROVAL" after each one.'
      );
    }
  }

  if (mode === 'follows') {
    const canFollow = await canPerformAction('follows');
    if (!canFollow) {
      return { ok: false, error: 'Daily follow limit reached (35/day).' };
    }

    if (config.autonomousMode) {
      return await startTask(
        'Find 8 Instagram users who recently engaged with top posts in #planespotting or #avgeek. ' +
        'For each person: visit their profile, verify their content is aviation-related, ' +
        'check we haven\'t followed them before. If suitable, follow them directly. ' +
        'Add a 3-5 second delay between each follow. ' +
        'After each follow say "AUTONOMOUS_ACTION: followed @[username]". ' +
        'Maximum 8 follows this session.'
      );
    } else {
      return await startTask(
        'Find 10 Instagram users who recently engaged with top posts in #planespotting or #avgeek. ' +
        'For each person: visit their profile, check their content is aviation-related, ' +
        'check we haven\'t followed them before. Add suitable accounts to the follow approval queue — ' +
        'do NOT follow yet. Say "AWAITING APPROVAL" for each one.'
      );
    }
  }
}

// ─── Approved Action Executor ─────────────────────────────────────────────────
async function executeApprovedAction(actionId) {
  const queue = await getActionQueue();
  const action = queue.find(a => a.id === actionId);
  if (!action) return { ok: false, error: 'Action not found.' };

  await removeFromActionQueue(actionId);

  let taskDescription = '';

  switch (action.type) {
    case 'comment':
      taskDescription =
        `Navigate to ${action.targetUrl}. ` +
        `Post exactly this comment in the comment box: "${action.draftText}". ` +
        'Click the post button. Wait 2 seconds to confirm it posted.';
      break;

    case 'follow':
      taskDescription =
        `Navigate to ${action.targetUrl}. ` +
        'Find the Follow button on the profile and click it. ' +
        'Wait 2 seconds to confirm the follow.';
      break;

    case 'reply':
      taskDescription =
        `Navigate to ${action.targetUrl}. ` +
        `Find the comment and reply with exactly: "${action.draftText}". Post the reply.`;
      break;

    case 'dm':
      taskDescription =
        `Navigate to ${action.targetUrl}. ` +
        `Send this DM: "${action.draftText}".`;
      break;

    default:
      return { ok: false, error: `Unknown action type: ${action.type}` };
  }

  // Record before executing
  if (action.type === 'comment' || action.type === 'reply') {
    await recordCommented(action.targetUrl);
  }
  if (action.type === 'follow') {
    const username = action.targetUrl?.split('/').filter(Boolean).pop();
    if (username) await recordFollowed(username);
  }

  const result = await startTask(taskDescription);
  sendToPanel({ type: 'action_executed', payload: { actionId, result } });
  return result;
}

// ─── Autonomous Mode ──────────────────────────────────────────────────────────
// Called on a schedule when autonomous mode is enabled.
// Claude decides what to do based on the current state and insights.
async function runAutonomousCycle() {
  const config = await getConfig();
  if (!config.autonomousMode) return { ok: false, error: 'Autonomous mode is off.' };

  const counts = await getDailyCounts();
  const canComment = counts.comments < 10;
  const canFollow  = counts.follows  < 35;

  if (!canComment && !canFollow) {
    return { ok: true, result: 'Daily limits reached. No autonomous actions taken.' };
  }

  const availableActions = [];
  if (canComment) availableActions.push(`comment on ${10 - counts.comments} more posts`);
  if (canFollow)  availableActions.push(`follow ${35 - counts.follows} more accounts`);

  const result = await startTask(
    `You are running an autonomous engagement cycle for an aviation Instagram account. ` +
    `Based on your knowledge of what grows aviation accounts, decide what to do right now. ` +
    `Available budget: ${availableActions.join(', ')}. ` +
    `\n\nYou can: scan trending aviation hashtags, comment on relevant posts, follow engaged aviation fans. ` +
    `Act on what you think will grow the account most effectively right now. ` +
    `Keep all actions specific and human-like. Add 3-5 second delays between actions. ` +
    `After each action say "AUTONOMOUS_ACTION: [what you did]". ` +
    `At the end, summarize what you did and why.`
  );

  // Parse autonomous actions from result and log them
  if (result.ok && result.result) {
    const lines = result.result.split('\n');
    for (const line of lines) {
      if (line.includes('AUTONOMOUS_ACTION:')) {
        const actionDesc = line.split('AUTONOMOUS_ACTION:')[1]?.trim();
        if (actionDesc) {
          await logAutonomousAction({ description: actionDesc, cycle: 'auto' });
        }
      }
    }

    // Notify via Telegram
    await telegramNotify('alert', {
      title: 'Autonomous Cycle Complete',
      body: result.result.slice(0, 600),
    });
  }

  return result;
}

// ─── Telegram Notifications ───────────────────────────────────────────────────
async function telegramNotify(type, payload) {
  const config = await getConfig();
  const { telegramBotToken: botToken, telegramChatId: chatId } = config;
  if (!botToken || !chatId) return;

  switch (type) {
    case 'approval':
      return await notifyApprovalNeeded({ botToken, chatId, action: payload.action });
    case 'post_idea':
      return await notifyPostIdea({ botToken, chatId, idea: payload.idea });
    case 'task_complete':
      return await notifyTaskComplete({ botToken, chatId, summary: payload.summary });
    case 'golden_hour':
      return await notifyGoldenHour({ botToken, chatId, ...payload });
    case 'alert':
      return await notifyAlert({ botToken, chatId, title: payload.title, body: payload.body });
  }
}

// Notify Telegram when a new item is added to the approval queue
const _origAddToActionQueue = addToActionQueue;
// We intercept by wrapping — background calls this wrapper instead
async function queueActionWithNotification(action) {
  const id = await addToActionQueue(action);
  sendToPanel({ type: 'queue_updated' });
  // Notify Telegram
  await telegramNotify('approval', { action: { ...action, id } });
  return id;
}

// ─── Telegram Callback Poller ─────────────────────────────────────────────────
// Every 30 seconds, check if the user tapped Approve/Reject in Telegram.
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'telegram_poll') {
    const config = await getConfig();
    if (!config.telegramBotToken) return;

    const decisions = await pollCallbackQueries(config.telegramBotToken);
    for (const { actionId, decision } of decisions) {
      if (decision === 'approve') {
        const result = await executeApprovedAction(actionId);
        sendToPanel({ type: 'queue_updated' });
        await telegramNotify('alert', {
          title: 'Action Executed',
          body: result.ok ? 'Done!' : `Failed: ${result.error}`,
        });
      } else {
        await removeFromActionQueue(actionId);
        sendToPanel({ type: 'queue_updated' });
      }
    }
  }

  if (alarm.name === 'golden_hour_check') {
    const goldenHour = await getGoldenHourPost();
    if (!goldenHour) {
      chrome.alarms.clear('golden_hour_check');
      return;
    }

    const result = await startTask(
      `Navigate to ${goldenHour.url}. Read all comments on the post. ` +
      'For each comment that isn\'t a simple emoji or spam, draft a warm, specific reply. ' +
      'Add each reply to the approval queue — do NOT post yet. ' +
      'Count how many new comments you found and include the number in your final response as "NEW_COMMENTS: N".'
    );

    // Parse comment count and send Telegram notification
    if (result.ok && result.result) {
      const match = result.result.match(/NEW_COMMENTS:\s*(\d+)/);
      const count = match ? parseInt(match[1]) : 0;
      if (count > 0) {
        await telegramNotify('golden_hour', { postUrl: goldenHour.url, commentCount: count });
      }
    }
  }

  if (alarm.name === 'autonomous_cycle') {
    const config = await getConfig();
    if (config.autonomousMode) {
      await runAutonomousCycle();
    }
  }
});

// ─── Golden Hour ──────────────────────────────────────────────────────────────
async function startGoldenHour(postUrl) {
  await setGoldenHourPost(postUrl);
  sendToPanel({ type: 'golden_hour_started', payload: { postUrl } });
  chrome.alarms.create('golden_hour_check', { periodInMinutes: 8 });
  await telegramNotify('alert', {
    title: 'Golden Hour Started',
    body: `Now monitoring your post for the next 90 minutes.\n${postUrl}`,
  });
  return { ok: true };
}

// ─── Tool Execution on Instagram Tab ─────────────────────────────────────────
async function executeToolOnInstagramTab(tool, params) {
  const tab = await getOrOpenInstagramTab();
  if (!tab) return { ok: false, error: 'Could not find or open Instagram tab.' };

  if (params.url) await saveLastUrl(params.url);

  if (tool === 'screenshot') return await captureTabScreenshot(tab.id);

  return await sendToContentScript(tab.id, tool, params);
}

async function sendToContentScript(tabId, tool, params) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(
      tabId,
      { source: 'iam_background', tool, params },
      response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'No response from content script' });
        }
      }
    );
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

// ─── Resume on Startup ────────────────────────────────────────────────────────
async function resumeStateOnStartup() {
  const [task, queue, goldenHour] = await Promise.all([
    loadCurrentTask(),
    getActionQueue(),
    getGoldenHourPost(),
  ]);

  if (!task && queue.length === 0 && !goldenHour) return null;

  return {
    previousTask:      task,
    pendingApprovals:  queue.length,
    goldenHourActive:  !!goldenHour,
  };
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function handleChat(prompt, history = []) {
  const config = await getConfig();
  if (!config.claudeApiKey) return { ok: false, error: 'No Claude API key set.' };
  return await chat({ apiKey: config.claudeApiKey, config, prompt, conversationHistory: history });
}

// ─── Caption Drafting ─────────────────────────────────────────────────────────
async function handleDraftCaption({ videoDescription, aircraftType, location }) {
  const config = await getConfig();
  const cluster = await getNextHashtagCluster();

  const prompt =
    `Draft an Instagram caption for my aviation video.\n\n` +
    `Video details:\n` +
    `- Description: ${videoDescription}\n` +
    `- Aircraft: ${aircraftType || 'not specified'}\n` +
    `- Location: ${location || 'not specified'}\n\n` +
    `Requirements:\n` +
    `- Opening hook (first line grabs attention)\n` +
    `- 2-3 sentences of engaging context (aircraft facts, flight details, or story)\n` +
    `- A call-to-action that encourages saves or shares\n` +
    `- End with these hashtags on a new line: ${cluster?.tags.join(' ')}\n\n` +
    `Tone: ${config.tonePreference}\n` +
    `Keep it under 200 words total.`;

  return await handleChat(prompt);
}

// ─── Extension Install / Startup ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Set up recurring alarms
  chrome.alarms.create('telegram_poll',    { periodInMinutes: 0.5 }); // every 30s
  chrome.alarms.create('autonomous_cycle', { periodInMinutes: 120 }); // every 2 hours
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('telegram_poll',    { periodInMinutes: 0.5 });
  chrome.alarms.create('autonomous_cycle', { periodInMinutes: 120 });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
