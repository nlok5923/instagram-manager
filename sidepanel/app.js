// ─── Side Panel App ───────────────────────────────────────────────────────────
// Full autonomy UI — chat, activity log, manual triggers, settings.

import { getConfig, saveConfig, saveChatHistory, loadChatHistory } from '../utils/storage.js';

// ─── State ────────────────────────────────────────────────────────────────────
let port = null;
let chatHistory = [];
let isTaskRunning = false;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  connectToBackground();
  setupTabs();
  setupChat();
  setupToolButtons();
  setupSettings();
  setupModals();
  loadSettings();
  refreshDailyCounts();
  refreshActivityLog();
  await restoreChatHistory();
});

// ─── Background Connection ────────────────────────────────────────────────────
function connectToBackground() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(handleBackgroundMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectToBackground, 1000);
  });
}

function sendToBackground(type, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ source: 'iam_panel', type, payload }, resolve);
  });
}

function handleBackgroundMessage(msg) {
  switch (msg.type) {
    case 'task_started':
      setTaskRunning(true, msg.payload.description);
      break;
    case 'task_status':
      updateStatusBar(msg.payload.status);
      break;
    case 'task_done':
      setTaskRunning(false);
      if (msg.payload.ok) addMessage('assistant', msg.payload.result);
      else addMessage('system', `Error: ${msg.payload.error}`);
      refreshActivityLog();
      refreshDailyCounts();
      break;
    case 'task_stopped':
      setTaskRunning(false);
      addMessage('system', 'Task stopped.');
      break;
    case 'activity_updated':
      refreshActivityLog();
      refreshDailyCounts();
      break;
    case 'golden_hour_started':
      addMessage('system', `Golden hour active — auto-replying to comments on your post.`);
      break;
    case 'resume_state':
      showResumeBanner(msg.payload);
      break;
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'activity') refreshActivityLog();
      if (tab.dataset.tab === 'tools')    refreshDailyCounts();
    });
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    activateTab('settings');
  });
}

function activateTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name)
  );
  document.querySelectorAll('.tab-content').forEach(c =>
    c.classList.toggle('active', c.id === `tab-${name}`)
  );
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function setupChat() {
  const input = document.getElementById('chat-input');
  document.getElementById('btn-send').addEventListener('click', submitChat);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitChat(); }
  });
  document.getElementById('btn-stop').addEventListener('click', () => {
    sendToBackground('stop_task');
  });
}

async function submitChat() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || isTaskRunning) return;

  input.value = '';
  addMessage('user', text);
  chatHistory.push({ role: 'user', content: text });
  await saveChatHistory(chatHistory);

  if (looksLikeBrowserTask(text)) {
    setTaskRunning(true, text);
    await sendToBackground('run_task', {
      task: text,
      conversationHistory: chatHistory.slice(-10),
    });
  } else {
    setTaskRunning(true, 'Thinking…');
    const result = await sendToBackground('chat', {
      prompt: text,
      history: chatHistory.slice(-10),
    });
    setTaskRunning(false);
    if (result?.ok) {
      addMessage('assistant', result.text);
      chatHistory.push({ role: 'assistant', content: result.text });
      await saveChatHistory(chatHistory);
    } else {
      addMessage('system', `Error: ${result?.error || 'Unknown error'}`);
    }
  }
}

async function restoreChatHistory() {
  const history = await loadChatHistory();
  if (!history.length) return;
  chatHistory = history;
  const messages = document.getElementById('chat-messages');
  // Render last 20 messages
  history.slice(-20).forEach(msg => {
    if (msg.role === 'user' || msg.role === 'assistant') {
      addMessage(msg.role, msg.content);
    }
  });
  messages.scrollTop = messages.scrollHeight;
}

function looksLikeBrowserTask(text) {
  const keywords = [
    'go to', 'navigate', 'open', 'visit', 'comment', 'follow', 'like',
    'post', 'scan', 'check', 'find', 'search instagram', 'look at',
    'hashtag', 'profile', 'scroll', 'click',
  ];
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

function addMessage(role, text) {
  const messages = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// ─── Task Status ──────────────────────────────────────────────────────────────
function setTaskRunning(running, description) {
  isTaskRunning = running;
  const bar = document.getElementById('task-status-bar');
  const dot = document.getElementById('status-dot');
  if (running) {
    bar.classList.remove('hidden');
    dot.className = 'dot working';
    updateStatusBar(description || 'Working…');
  } else {
    bar.classList.add('hidden');
    dot.className = 'dot idle';
  }
}

function updateStatusBar(text) {
  document.getElementById('task-status-text').textContent = text;
}

// ─── Tool Buttons ─────────────────────────────────────────────────────────────
function setupToolButtons() {
  document.querySelectorAll('.tool-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      addMessage('system', `Running: ${btn.querySelector('strong').textContent}…`);
      activateTab('chat');
      const result = await sendToBackground(btn.dataset.action);
      if (!result?.ok && result?.error) {
        addMessage('system', `Error: ${result.error}`);
        setTaskRunning(false);
      }
    });
  });

  document.getElementById('btn-draft-caption').addEventListener('click', () => {
    document.getElementById('modal-caption').classList.remove('hidden');
  });

  document.getElementById('btn-golden-hour').addEventListener('click', () => {
    document.getElementById('modal-golden').classList.remove('hidden');
  });
}

// ─── Activity Log ─────────────────────────────────────────────────────────────
async function refreshActivityLog() {
  const result = await sendToBackground('get_activity');
  const log    = result?.log || [];

  const list    = document.getElementById('activity-log-list');
  const badge   = document.getElementById('error-badge');
  const summary = document.getElementById('activity-summary');
  list.innerHTML = '';

  if (log.length === 0) {
    list.innerHTML = '<div class="empty-state">No activity yet. The AI will start acting on its schedule.</div>';
    badge.classList.add('hidden');
    summary.textContent = '—';
    return;
  }

  const errorCount  = log.filter(e => e.type === 'error').length;
  const actionCount = log.filter(e => ['comment','follow','like','reply'].includes(e.type)).length;

  // Update error badge on tab
  if (errorCount > 0) {
    badge.textContent = errorCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  summary.textContent = `${actionCount} action${actionCount !== 1 ? 's' : ''} · ${errorCount} error${errorCount !== 1 ? 's' : ''}`;

  log.forEach(entry => {
    const item = document.createElement('div');
    item.className = `log-item ${entry.type || ''}`;

    const typeIcon = {
      comment:   '💬',
      follow:    '➕',
      like:      '❤️',
      reply:     '↩️',
      error:     '⚠️',
      task:      '▶',
      task_done: '✓',
    }[entry.type] || '•';

    item.innerHTML = `
      <div class="log-item-time">${formatTime(entry.executedAt)}</div>
      <div class="log-item-desc">${escapeHtml(typeIcon + ' ' + (entry.description || ''))}</div>
    `;
    list.appendChild(item);
  });

  // Wire clear errors button
  document.getElementById('btn-clear-errors').onclick = async () => {
    // Remove error entries from the displayed list only (keep non-errors)
    document.querySelectorAll('.log-item.error').forEach(el => el.remove());
    badge.classList.add('hidden');
    // Re-count
    const remaining = document.querySelectorAll('.log-item').length;
    if (remaining === 0) {
      list.innerHTML = '<div class="empty-state">No activity yet.</div>';
    }
    summary.textContent = `${actionCount} action${actionCount !== 1 ? 's' : ''} · 0 errors`;
  };
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ─── Daily Counts ─────────────────────────────────────────────────────────────
async function refreshDailyCounts() {
  const result = await sendToBackground('get_daily_counts');
  if (!result?.counts) return;
  const { follows, comments, likes, dms } = result.counts;
  document.getElementById('count-follows').textContent  = `${follows} / 35`;
  document.getElementById('count-comments').textContent = `${comments} / 10`;
  document.getElementById('count-likes').textContent    = `${likes} / 60`;
  document.getElementById('count-dms').textContent      = `${dms} / 5`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  const config = await getConfig();
  document.getElementById('input-api-key').value      = config.claudeApiKey;
  document.getElementById('input-niche').value        = config.accountNiche;
  document.getElementById('input-tone').value         = config.tonePreference;
  document.getElementById('input-tg-token').value     = config.telegramBotToken;
  document.getElementById('input-tg-chat').value      = config.telegramChatId;
  document.getElementById('input-autonomous').checked = config.autonomousMode;
}

function setupSettings() {
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    await saveConfig({
      claudeApiKey:     document.getElementById('input-api-key').value.trim(),
      accountNiche:     document.getElementById('input-niche').value.trim(),
      tonePreference:   document.getElementById('input-tone').value.trim(),
      telegramBotToken: document.getElementById('input-tg-token').value.trim(),
      telegramChatId:   document.getElementById('input-tg-chat').value.trim(),
      autonomousMode:   document.getElementById('input-autonomous').checked,
    });
    const msg = document.getElementById('settings-saved');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2000);
  });

  document.getElementById('btn-test-telegram').addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-telegram');
    btn.textContent = 'Sending…';
    btn.disabled = true;

    const config = await getConfig();
    const { sendMessage } = await import('../utils/telegram.js');
    const r = await sendMessage({
      botToken: config.telegramBotToken,
      chatId:   config.telegramChatId,
      text:     '✅ <b>Aviation Manager</b> is connected! I\'ll keep you updated here.',
    });

    btn.textContent = r.ok ? 'Sent ✓' : 'Failed';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Test Telegram'; }, 2500);
  });
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function setupModals() {
  document.getElementById('btn-modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-caption').classList.add('hidden');
  });

  document.getElementById('btn-modal-draft').addEventListener('click', async () => {
    const videoDescription = document.getElementById('caption-video-desc').value.trim();
    const aircraftType     = document.getElementById('caption-aircraft').value.trim();
    const location         = document.getElementById('caption-location').value.trim();
    if (!videoDescription) return;

    document.getElementById('modal-caption').classList.add('hidden');
    addMessage('user', `Draft caption for: ${videoDescription}`);
    activateTab('chat');
    setTaskRunning(true, 'Drafting caption…');

    const result = await sendToBackground('draft_caption', { videoDescription, aircraftType, location });
    setTaskRunning(false);
    if (result?.ok) addMessage('assistant', result.text);
    else addMessage('system', `Error: ${result?.error}`);
  });

  document.getElementById('btn-golden-cancel').addEventListener('click', () => {
    document.getElementById('modal-golden').classList.add('hidden');
  });

  document.getElementById('btn-golden-start').addEventListener('click', async () => {
    const url = document.getElementById('golden-post-url').value.trim();
    if (!url.includes('instagram.com')) return;
    document.getElementById('modal-golden').classList.add('hidden');
    activateTab('chat');
    await sendToBackground('start_golden_hour', { postUrl: url });
  });
}

// ─── Resume Banner ────────────────────────────────────────────────────────────
function showResumeBanner(state) {
  const chatMessages = document.getElementById('chat-messages');
  const banner = document.createElement('div');
  banner.className = 'resume-banner';
  banner.innerHTML = `
    <strong>Welcome back</strong>
    ${state.previousTask ? `<div>Resuming: ${state.previousTask.description.slice(0, 80)}…</div>` : ''}
    ${state.goldenHourActive ? `<div>Golden hour monitoring is still active.</div>` : ''}
    <div class="resume-banner-actions">
      ${state.previousTask ? `<button class="primary-btn" id="btn-resume-task">Resume</button>` : ''}
      <button class="secondary-btn" id="btn-resume-dismiss">Dismiss</button>
    </div>
  `;
  chatMessages.prepend(banner);

  document.getElementById('btn-resume-task')?.addEventListener('click', async () => {
    banner.remove();
    await sendToBackground('run_task', { task: state.previousTask.description });
  });
  document.getElementById('btn-resume-dismiss')?.addEventListener('click', () => banner.remove());
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
