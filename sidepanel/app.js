// ─── Side Panel App ───────────────────────────────────────────────────────────
// Handles all UI logic: tabs, chat, action queue, tool buttons, settings, modals.

import { getConfig, saveConfig } from '../utils/storage.js';

// ─── State ────────────────────────────────────────────────────────────────────
let port = null;
let chatHistory = [];
let isTaskRunning = false;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectToBackground();
  setupTabs();
  setupChat();
  setupToolButtons();
  setupSettings();
  setupModals();
  loadSettings();
  refreshDailyCounts();
  refreshActionQueue();
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
    chrome.runtime.sendMessage(
      { source: 'iam_panel', type, payload },
      resolve
    );
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
      if (msg.payload.ok) {
        addMessage('assistant', msg.payload.result);
      } else {
        addMessage('system', `Error: ${msg.payload.error}`);
      }
      refreshActionQueue();
      refreshDailyCounts();
      break;

    case 'task_stopped':
      setTaskRunning(false);
      addMessage('system', 'Task stopped.');
      break;

    case 'golden_hour_started':
      addMessage('system', `Golden hour started. Monitoring ${msg.payload.postUrl}`);
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

      if (tab.dataset.tab === 'queue') refreshActionQueue();
      if (tab.dataset.tab === 'tools') refreshDailyCounts();
    });
  });

  // Settings icon → jump to settings tab
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === 'settings');
    });
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === 'tab-settings');
    });
  });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function setupChat() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send');

  sendBtn.addEventListener('click', submitChat);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitChat();
    }
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    sendToBackground('stop_task');
  });
}

async function submitChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || isTaskRunning) return;

  input.value = '';
  addMessage('user', text);

  // Decide: is this a browser action task or a pure chat query?
  const isBrowserTask = looksLikeBrowserTask(text);

  setTaskRunning(true, text);

  let result;
  if (isBrowserTask) {
    result = await sendToBackground('run_task', {
      task: text,
      conversationHistory: chatHistory.slice(-10),
    });
  } else {
    result = await sendToBackground('chat', {
      prompt: text,
      history: chatHistory.slice(-10),
    });
    setTaskRunning(false);
    if (result?.ok) {
      addMessage('assistant', result.text);
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: result.text });
    } else {
      addMessage('system', `Error: ${result?.error || 'Unknown error'}`);
    }
  }
}

function looksLikeBrowserTask(text) {
  const browserKeywords = [
    'go to', 'navigate', 'open', 'visit', 'comment', 'follow', 'like',
    'post', 'scan', 'check', 'find', 'search instagram', 'look at',
    'hashtag', 'profile', 'scroll', 'click'
  ];
  const lower = text.toLowerCase();
  return browserKeywords.some(kw => lower.includes(kw));
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
  // Simple action buttons
  document.querySelectorAll('.tool-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      addMessage('system', `Starting: ${btn.querySelector('strong').textContent}…`);
      switchToChat();
      const result = await sendToBackground(action);
      if (!result?.ok && result?.error) {
        addMessage('system', `Error: ${result.error}`);
        setTaskRunning(false);
      }
    });
  });

  // Caption draft → modal
  document.getElementById('btn-draft-caption').addEventListener('click', () => {
    document.getElementById('modal-caption').classList.remove('hidden');
  });

  // Golden hour → modal
  document.getElementById('btn-golden-hour').addEventListener('click', () => {
    document.getElementById('modal-golden').classList.remove('hidden');
  });
}

function switchToChat() {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === 'chat')
  );
  document.querySelectorAll('.tab-content').forEach(c =>
    c.classList.toggle('active', c.id === 'tab-chat')
  );
}

// ─── Action Queue ─────────────────────────────────────────────────────────────
async function refreshActionQueue() {
  const result = await sendToBackground('get_action_queue');
  const queue = result?.queue || [];

  const badge = document.getElementById('queue-badge');
  if (queue.length > 0) {
    badge.textContent = queue.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const list = document.getElementById('action-queue-list');
  list.innerHTML = '';

  if (queue.length === 0) {
    list.innerHTML = '<div class="empty-state">No pending actions.</div>';
    return;
  }

  queue.forEach(action => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    item.innerHTML = `
      <div class="queue-item-type">${formatActionType(action.type)}</div>
      ${action.targetUrl ? `<div class="queue-item-target">${action.targetUrl}</div>` : ''}
      <div class="queue-item-draft">${escapeHtml(action.draftText || '')}</div>
      <div class="queue-item-actions">
        <button class="approve-btn" data-id="${action.id}">Approve</button>
        <button class="reject-btn" data-id="${action.id}">Reject</button>
      </div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.approve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Executing…';
      const result = await sendToBackground('approve_action', { actionId: btn.dataset.id });
      if (!result?.ok) {
        btn.textContent = 'Failed';
        btn.style.background = 'var(--red)';
      } else {
        btn.closest('.queue-item').remove();
        refreshActionQueue();
        refreshDailyCounts();
      }
    });
  });

  list.querySelectorAll('.reject-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await sendToBackground('reject_action', { actionId: btn.dataset.id });
      btn.closest('.queue-item').remove();
      refreshActionQueue();
    });
  });
}

function formatActionType(type) {
  const map = {
    comment: '💬 Comment',
    follow:  '+ Follow',
    reply:   '↩ Reply',
    dm:      '✉ DM',
    like:    '♥ Like',
  };
  return map[type] || type;
}

// ─── Daily Counts ─────────────────────────────────────────────────────────────
async function refreshDailyCounts() {
  const result = await sendToBackground('get_daily_counts');
  if (!result?.counts) return;
  const { follows, comments, likes, dms } = result.counts;
  document.getElementById('count-follows').textContent   = `${follows} / 35`;
  document.getElementById('count-comments').textContent  = `${comments} / 10`;
  document.getElementById('count-likes').textContent     = `${likes} / 60`;
  document.getElementById('count-dms').textContent       = `${dms} / 5`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  const config = await getConfig();
  document.getElementById('input-api-key').value    = config.claudeApiKey;
  document.getElementById('input-niche').value      = config.accountNiche;
  document.getElementById('input-tone').value       = config.tonePreference;
  document.getElementById('input-tg-token').value   = config.telegramBotToken;
  document.getElementById('input-tg-chat').value    = config.telegramChatId;
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

    const result = await sendToBackground('chat', {
      prompt: 'Send a Telegram test message saying "Aviation Manager connected successfully!"',
    });

    // Actually send via background
    await sendToBackground('run_autonomous_cycle'); // triggers Telegram path
    // Simpler: directly fire a test notification
    const config = await getConfig();
    const { sendMessage } = await import('../utils/telegram.js');
    const r = await sendMessage({
      botToken: config.telegramBotToken,
      chatId:   config.telegramChatId,
      text:     '✅ <b>Aviation Manager</b> is connected to Telegram!',
    });

    btn.textContent = r.ok ? 'Sent!' : 'Failed';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Test Telegram'; }, 2000);
  });
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function setupModals() {
  // Caption modal
  document.getElementById('btn-modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-caption').classList.add('hidden');
  });

  document.getElementById('btn-modal-draft').addEventListener('click', async () => {
    const videoDescription = document.getElementById('caption-video-desc').value.trim();
    const aircraftType     = document.getElementById('caption-aircraft').value.trim();
    const location         = document.getElementById('caption-location').value.trim();

    if (!videoDescription) return;
    document.getElementById('modal-caption').classList.add('hidden');

    addMessage('user', `Draft a caption for: ${videoDescription}`);
    switchToChat();
    setTaskRunning(true, 'Drafting caption…');

    const result = await sendToBackground('draft_caption', {
      videoDescription, aircraftType, location
    });

    setTaskRunning(false);
    if (result?.ok) {
      addMessage('assistant', result.text);
    } else {
      addMessage('system', `Error: ${result?.error}`);
    }
  });

  // Golden hour modal
  document.getElementById('btn-golden-cancel').addEventListener('click', () => {
    document.getElementById('modal-golden').classList.add('hidden');
  });

  document.getElementById('btn-golden-start').addEventListener('click', async () => {
    const url = document.getElementById('golden-post-url').value.trim();
    if (!url.includes('instagram.com')) return;
    document.getElementById('modal-golden').classList.add('hidden');
    switchToChat();
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
    ${state.previousTask ? `<div>Last task: ${state.previousTask.description.slice(0, 80)}…</div>` : ''}
    ${state.pendingApprovals > 0 ? `<div>${state.pendingApprovals} action(s) waiting for your approval.</div>` : ''}
    ${state.goldenHourActive ? `<div>Golden hour monitoring is active.</div>` : ''}
    <div class="resume-banner-actions">
      ${state.previousTask ? `<button class="primary-btn" id="btn-resume-task">Resume Task</button>` : ''}
      ${state.pendingApprovals > 0 ? `<button class="secondary-btn" id="btn-resume-queue">View Queue</button>` : ''}
    </div>
  `;
  chatMessages.prepend(banner);

  document.getElementById('btn-resume-task')?.addEventListener('click', async () => {
    banner.remove();
    addMessage('system', 'Resuming previous task…');
    await sendToBackground('run_task', {
      task: state.previousTask.description,
      conversationHistory: [],
    });
  });

  document.getElementById('btn-resume-queue')?.addEventListener('click', () => {
    banner.remove();
    document.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === 'queue')
    );
    document.querySelectorAll('.tab-content').forEach(c =>
      c.classList.toggle('active', c.id === 'tab-queue')
    );
    refreshActionQueue();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
