// ─── Storage Manager ─────────────────────────────────────────────────────────
// All persistent memory for the extension lives here.
// Two buckets:
//   SESSION  — what was happening when the extension last closed (for resume)
//   MEMORY   — long-term history, counters, learned preferences

const KEYS = {
  // Session state
  CURRENT_TASK:         'session_current_task',
  LAST_URL:             'session_last_url',
  ACTION_QUEUE:         'session_action_queue',
  GOLDEN_HOUR_POST:     'session_golden_hour_post',

  // Daily rate limit counters
  DAILY_COUNTS:         'daily_counts',
  DAILY_COUNTS_DATE:    'daily_counts_date',

  // Long-term memory
  FOLLOWED_ACCOUNTS:    'mem_followed',
  COMMENTED_POSTS:      'mem_commented',
  HASHTAG_CLUSTERS:     'mem_hashtag_clusters',
  CAPTIONS_USED:        'mem_captions_used',
  POST_SCHEDULE:        'mem_post_schedule',
  BEST_POSTING_TIMES:   'mem_best_times',
  HASHTAG_PERFORMANCE:  'mem_hashtag_perf',

  // Config
  CLAUDE_API_KEY:       'config_claude_key',
  ACCOUNT_NICHE:        'config_niche',
  TONE_PREFERENCE:      'config_tone',
  TELEGRAM_BOT_TOKEN:   'config_tg_token',
  TELEGRAM_CHAT_ID:     'config_tg_chat_id',
  AUTONOMOUS_MODE:      'config_autonomous_mode',
  MODEL_ID:             'config_model_id',
  API_BASE_URL:         'config_api_base_url',

  // Activity log (what the AI has done)
  AUTONOMOUS_LOG:       'mem_autonomous_log',
  ACTIVITY_LOG:         'mem_activity_log',

  // Chat history
  CHAT_HISTORY:         'mem_chat_history',

  // Error log
  ERROR_LOG:            'mem_error_log',
};

// ─── Daily Limits ─────────────────────────────────────────────────────────────
const DAILY_LIMITS = {
  follows:   35,
  comments:  10,
  likes:     60,
  dms:        5,
};

async function getDailyCounts() {
  const { [KEYS.DAILY_COUNTS]: counts, [KEYS.DAILY_COUNTS_DATE]: date } =
    await chrome.storage.local.get([KEYS.DAILY_COUNTS, KEYS.DAILY_COUNTS_DATE]);

  const today = new Date().toISOString().slice(0, 10);
  if (date !== today) {
    // New day — reset counters
    const fresh = { follows: 0, comments: 0, likes: 0, dms: 0 };
    await chrome.storage.local.set({
      [KEYS.DAILY_COUNTS]: fresh,
      [KEYS.DAILY_COUNTS_DATE]: today,
    });
    return fresh;
  }
  return counts || { follows: 0, comments: 0, likes: 0, dms: 0 };
}

async function incrementCount(action) {
  const counts = await getDailyCounts();
  counts[action] = (counts[action] || 0) + 1;
  await chrome.storage.local.set({ [KEYS.DAILY_COUNTS]: counts });
  return counts[action];
}

async function canPerformAction(action) {
  const counts = await getDailyCounts();
  return (counts[action] || 0) < (DAILY_LIMITS[action] || Infinity);
}

// ─── Session State ────────────────────────────────────────────────────────────
async function saveCurrentTask(task) {
  await chrome.storage.local.set({ [KEYS.CURRENT_TASK]: task });
}

async function loadCurrentTask() {
  const { [KEYS.CURRENT_TASK]: task } = await chrome.storage.local.get(KEYS.CURRENT_TASK);
  return task || null;
}

async function clearCurrentTask() {
  await chrome.storage.local.remove(KEYS.CURRENT_TASK);
}

async function saveLastUrl(url) {
  await chrome.storage.local.set({ [KEYS.LAST_URL]: url });
}

async function loadLastUrl() {
  const { [KEYS.LAST_URL]: url } = await chrome.storage.local.get(KEYS.LAST_URL);
  return url || null;
}

// ─── Action Queue (pending approvals) ────────────────────────────────────────
async function getActionQueue() {
  const { [KEYS.ACTION_QUEUE]: queue } = await chrome.storage.local.get(KEYS.ACTION_QUEUE);
  return queue || [];
}

async function addToActionQueue(action) {
  // action shape: { id, type, payload, draftText, targetUrl, createdAt }
  const queue = await getActionQueue();
  action.id = action.id || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  action.createdAt = action.createdAt || Date.now();
  queue.push(action);
  await chrome.storage.local.set({ [KEYS.ACTION_QUEUE]: queue });
  return action.id;
}

async function removeFromActionQueue(id) {
  const queue = await getActionQueue();
  const updated = queue.filter(a => a.id !== id);
  await chrome.storage.local.set({ [KEYS.ACTION_QUEUE]: updated });
}

async function clearActionQueue() {
  await chrome.storage.local.set({ [KEYS.ACTION_QUEUE]: [] });
}

// ─── Golden Hour ──────────────────────────────────────────────────────────────
async function setGoldenHourPost(postUrl) {
  await chrome.storage.local.set({
    [KEYS.GOLDEN_HOUR_POST]: { url: postUrl, startedAt: Date.now() }
  });
}

async function getGoldenHourPost() {
  const { [KEYS.GOLDEN_HOUR_POST]: data } = await chrome.storage.local.get(KEYS.GOLDEN_HOUR_POST);
  if (!data) return null;
  // Golden hour expires after 90 minutes
  if (Date.now() - data.startedAt > 90 * 60 * 1000) {
    await chrome.storage.local.remove(KEYS.GOLDEN_HOUR_POST);
    return null;
  }
  return data;
}

// ─── Long-term Memory ─────────────────────────────────────────────────────────
async function recordFollowed(username) {
  const { [KEYS.FOLLOWED_ACCOUNTS]: list = [] } =
    await chrome.storage.local.get(KEYS.FOLLOWED_ACCOUNTS);
  list.push({ username, followedAt: Date.now() });
  // Keep last 2000 entries
  const trimmed = list.slice(-2000);
  await chrome.storage.local.set({ [KEYS.FOLLOWED_ACCOUNTS]: trimmed });
  await incrementCount('follows');
}

async function hasFollowed(username) {
  const { [KEYS.FOLLOWED_ACCOUNTS]: list = [] } =
    await chrome.storage.local.get(KEYS.FOLLOWED_ACCOUNTS);
  return list.some(e => e.username === username);
}

async function recordCommented(postUrl) {
  const { [KEYS.COMMENTED_POSTS]: list = [] } =
    await chrome.storage.local.get(KEYS.COMMENTED_POSTS);
  list.push({ postUrl, commentedAt: Date.now() });
  const trimmed = list.slice(-5000);
  await chrome.storage.local.set({ [KEYS.COMMENTED_POSTS]: trimmed });
  await incrementCount('comments');
}

async function hasCommented(postUrl) {
  const { [KEYS.COMMENTED_POSTS]: list = [] } =
    await chrome.storage.local.get(KEYS.COMMENTED_POSTS);
  return list.some(e => e.postUrl === postUrl);
}

// ─── Hashtag Clusters ─────────────────────────────────────────────────────────
const DEFAULT_HASHTAG_CLUSTERS = [
  {
    id: 'cluster_a',
    tags: ['#aviation', '#planespotting', '#avgeek', '#aircraftlovers', '#widebodywednesday']
  },
  {
    id: 'cluster_b',
    tags: ['#aircraft', '#aviationphotography', '#jetphotos', '#cockpitview', '#airplanepictures']
  },
  {
    id: 'cluster_c',
    tags: ['#aviation', '#aviationgeek', '#airplanelovers', '#aviationdaily', '#planephotography']
  },
];

async function getHashtagClusters() {
  const { [KEYS.HASHTAG_CLUSTERS]: clusters } =
    await chrome.storage.local.get(KEYS.HASHTAG_CLUSTERS);
  return clusters || DEFAULT_HASHTAG_CLUSTERS;
}

async function getNextHashtagCluster() {
  // Rotates through clusters to avoid repetition
  const clusters = await getHashtagClusters();
  const { [KEYS.HASHTAG_PERFORMANCE]: perf = {} } =
    await chrome.storage.local.get(KEYS.HASHTAG_PERFORMANCE);

  // Pick least recently used cluster
  let oldest = null;
  let oldestTime = Infinity;
  for (const cluster of clusters) {
    const lastUsed = perf[cluster.id]?.lastUsed || 0;
    if (lastUsed < oldestTime) {
      oldestTime = lastUsed;
      oldest = cluster;
    }
  }

  // Mark as used
  if (oldest) {
    perf[oldest.id] = { ...perf[oldest.id], lastUsed: Date.now() };
    await chrome.storage.local.set({ [KEYS.HASHTAG_PERFORMANCE]: perf });
  }

  return oldest;
}

// ─── Post Schedule ────────────────────────────────────────────────────────────
async function getPostSchedule() {
  const { [KEYS.POST_SCHEDULE]: schedule = [] } =
    await chrome.storage.local.get(KEYS.POST_SCHEDULE);
  return schedule;
}

async function addToPostSchedule(post) {
  // post: { id, caption, hashtags, mediaPath, scheduledFor (timestamp) }
  const schedule = await getPostSchedule();
  post.id = post.id || `post_${Date.now()}`;
  schedule.push(post);
  await chrome.storage.local.set({ [KEYS.POST_SCHEDULE]: schedule });
  return post.id;
}

async function removeFromPostSchedule(id) {
  const schedule = await getPostSchedule();
  const updated = schedule.filter(p => p.id !== id);
  await chrome.storage.local.set({ [KEYS.POST_SCHEDULE]: updated });
}

// ─── Config ───────────────────────────────────────────────────────────────────
async function getConfig() {
  const keys = [
    KEYS.CLAUDE_API_KEY, KEYS.ACCOUNT_NICHE, KEYS.TONE_PREFERENCE,
    KEYS.TELEGRAM_BOT_TOKEN, KEYS.TELEGRAM_CHAT_ID, KEYS.AUTONOMOUS_MODE,
    KEYS.MODEL_ID, KEYS.API_BASE_URL,
  ];
  const result = await chrome.storage.local.get(keys);
  return {
    claudeApiKey:      result[KEYS.CLAUDE_API_KEY]       || '',
    accountNiche:      result[KEYS.ACCOUNT_NICHE]        || 'aviation, planes, aircraft spotting videos',
    tonePreference:    result[KEYS.TONE_PREFERENCE]      || 'enthusiastic but knowledgeable, fellow avgeek',
    telegramBotToken:  result[KEYS.TELEGRAM_BOT_TOKEN]   || '',
    telegramChatId:    result[KEYS.TELEGRAM_CHAT_ID]     || '',
    autonomousMode:    result[KEYS.AUTONOMOUS_MODE]      ?? true,
    modelId:           result[KEYS.MODEL_ID]             || '',
    apiBaseUrl:        result[KEYS.API_BASE_URL]         || '',
  };
}

async function saveConfig(config) {
  const updates = {};
  if (config.claudeApiKey      !== undefined) updates[KEYS.CLAUDE_API_KEY]      = config.claudeApiKey;
  if (config.accountNiche      !== undefined) updates[KEYS.ACCOUNT_NICHE]       = config.accountNiche;
  if (config.tonePreference    !== undefined) updates[KEYS.TONE_PREFERENCE]     = config.tonePreference;
  if (config.telegramBotToken  !== undefined) updates[KEYS.TELEGRAM_BOT_TOKEN]  = config.telegramBotToken;
  if (config.telegramChatId    !== undefined) updates[KEYS.TELEGRAM_CHAT_ID]    = config.telegramChatId;
  if (config.autonomousMode    !== undefined) updates[KEYS.AUTONOMOUS_MODE]     = config.autonomousMode;
  if (config.modelId           !== undefined) updates[KEYS.MODEL_ID]            = config.modelId;
  if (config.apiBaseUrl        !== undefined) updates[KEYS.API_BASE_URL]        = config.apiBaseUrl;
  await chrome.storage.local.set(updates);
}

// ─── Autonomous Action Log ────────────────────────────────────────────────────
async function logAutonomousAction(action) {
  const { [KEYS.AUTONOMOUS_LOG]: log = [] } =
    await chrome.storage.local.get(KEYS.AUTONOMOUS_LOG);
  log.unshift({ ...action, executedAt: Date.now() });
  // Keep last 500 entries
  await chrome.storage.local.set({ [KEYS.AUTONOMOUS_LOG]: log.slice(0, 500) });
}

async function getAutonomousLog() {
  const { [KEYS.AUTONOMOUS_LOG]: log = [] } =
    await chrome.storage.local.get(KEYS.AUTONOMOUS_LOG);
  return log;
}

// ─── Activity Log (unified feed of everything the AI did) ─────────────────────
// entry shape: { type, description, targetUrl, executedAt }
async function addActivity(entry) {
  const { [KEYS.ACTIVITY_LOG]: log = [] } =
    await chrome.storage.local.get(KEYS.ACTIVITY_LOG);
  log.unshift({ ...entry, executedAt: entry.executedAt || Date.now() });
  await chrome.storage.local.set({ [KEYS.ACTIVITY_LOG]: log.slice(0, 1000) });
}

async function getActivityLog() {
  const { [KEYS.ACTIVITY_LOG]: log = [] } =
    await chrome.storage.local.get(KEYS.ACTIVITY_LOG);
  return log;
}

// ─── Error Log ───────────────────────────────────────────────────────────────
// entry shape: { context, message, detail, occurredAt }
async function logError(context, message, detail = '') {
  const { [KEYS.ERROR_LOG]: log = [] } =
    await chrome.storage.local.get(KEYS.ERROR_LOG);

  const entry = {
    context,
    message: String(message).slice(0, 300),
    detail:  String(detail).slice(0, 500),
    occurredAt: Date.now(),
  };

  log.unshift(entry);
  await chrome.storage.local.set({ [KEYS.ERROR_LOG]: log.slice(0, 200) });

  // Also push into the activity log so it's visible in one place
  await addActivity({ type: 'error', description: `[${context}] ${message}` });
}

async function getErrorLog() {
  const { [KEYS.ERROR_LOG]: log = [] } =
    await chrome.storage.local.get(KEYS.ERROR_LOG);
  return log;
}

async function clearErrorLog() {
  await chrome.storage.local.set({ [KEYS.ERROR_LOG]: [] });
}

// ─── Chat History ─────────────────────────────────────────────────────────────
async function saveChatHistory(messages) {
  // Keep last 40 messages to avoid storage bloat
  await chrome.storage.local.set({ [KEYS.CHAT_HISTORY]: messages.slice(-40) });
}

async function loadChatHistory() {
  const { [KEYS.CHAT_HISTORY]: history = [] } =
    await chrome.storage.local.get(KEYS.CHAT_HISTORY);
  return history;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
export {
  DAILY_LIMITS,
  getDailyCounts,
  incrementCount,
  canPerformAction,
  saveCurrentTask,
  loadCurrentTask,
  clearCurrentTask,
  saveLastUrl,
  loadLastUrl,
  getActionQueue,
  addToActionQueue,
  removeFromActionQueue,
  clearActionQueue,
  setGoldenHourPost,
  getGoldenHourPost,
  recordFollowed,
  hasFollowed,
  recordCommented,
  hasCommented,
  getHashtagClusters,
  getNextHashtagCluster,
  getPostSchedule,
  addToPostSchedule,
  removeFromPostSchedule,
  getConfig,
  saveConfig,
  logAutonomousAction,
  getAutonomousLog,
  addActivity,
  getActivityLog,
  saveChatHistory,
  loadChatHistory,
  logError,
  getErrorLog,
  clearErrorLog,
};
