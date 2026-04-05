// ─── Telegram Notifier ────────────────────────────────────────────────────────
// Sends messages to the user via their Telegram bot.
// Uses the Telegram Bot API directly (no SDK needed — just fetch).
//
// Setup (user does this once):
//   1. Message @BotFather on Telegram → /newbot → get bot token
//   2. Start a chat with the bot
//   3. Visit https://api.telegram.org/bot{TOKEN}/getUpdates to get your chat_id
//   4. Paste both into extension Settings

const TELEGRAM_API = 'https://api.telegram.org';

// ─── Core Send ────────────────────────────────────────────────────────────────
export async function sendMessage({ botToken, chatId, text, parseMode = 'HTML', replyMarkup }) {
  if (!botToken || !chatId) return { ok: false, error: 'Telegram not configured.' };

  const body = {
    chat_id:    chatId,
    text:       text.slice(0, 4096), // Telegram max
    parse_mode: parseMode,
  };

  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const data = await res.json();
    return data.ok ? { ok: true } : { ok: false, error: data.description };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Approval Request ─────────────────────────────────────────────────────────
// Sends an action needing approval with inline buttons.
// The user taps Approve/Reject in Telegram — response is handled by the poll loop.
export async function notifyApprovalNeeded({ botToken, chatId, action }) {
  const typeEmoji = { comment: '💬', follow: '➕', reply: '↩️', dm: '✉️', like: '❤️' };
  const emoji = typeEmoji[action.type] || '📋';

  const text =
    `${emoji} <b>Action needs your approval</b>\n\n` +
    `<b>Type:</b> ${action.type}\n` +
    (action.targetUrl ? `<b>Target:</b> ${action.targetUrl}\n` : '') +
    `\n<b>Draft:</b>\n${escapeHtml(action.draftText || '')}`;

  return await sendMessage({
    botToken,
    chatId,
    text,
    replyMarkup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${action.id}` },
        { text: '❌ Reject',  callback_data: `reject:${action.id}`  },
      ]],
    },
  });
}

// ─── Post Idea Notification ───────────────────────────────────────────────────
export async function notifyPostIdea({ botToken, chatId, idea }) {
  const text =
    `✈️ <b>Post Idea from your Aviation Manager</b>\n\n` +
    `${escapeHtml(idea)}`;

  return await sendMessage({ botToken, chatId, text });
}

// ─── Task Complete Notification ───────────────────────────────────────────────
export async function notifyTaskComplete({ botToken, chatId, summary }) {
  const text =
    `✅ <b>Task Complete</b>\n\n` +
    `${escapeHtml(summary.slice(0, 800))}`;

  return await sendMessage({ botToken, chatId, text });
}

// ─── Golden Hour Notification ─────────────────────────────────────────────────
export async function notifyGoldenHour({ botToken, chatId, postUrl, commentCount }) {
  const text =
    `⏱ <b>Golden Hour Update</b>\n\n` +
    `Your post received <b>${commentCount} new comment(s)</b>.\n` +
    `Replies are drafted and waiting for your approval in the extension queue.\n\n` +
    `<a href="${postUrl}">View post</a>`;

  return await sendMessage({ botToken, chatId, text });
}

// ─── Generic Alert ────────────────────────────────────────────────────────────
export async function notifyAlert({ botToken, chatId, title, body: bodyText }) {
  const text = `🔔 <b>${escapeHtml(title)}</b>\n\n${escapeHtml(bodyText)}`;
  return await sendMessage({ botToken, chatId, text });
}

// ─── Callback Query Poller ────────────────────────────────────────────────────
// Polls Telegram for button tap responses (approve/reject from Telegram).
// Returns an array of { actionId, decision: 'approve' | 'reject' }.
let lastUpdateId = 0;

export async function pollCallbackQueries(botToken) {
  if (!botToken) return [];

  try {
    const res = await fetch(
      `${TELEGRAM_API}/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=1&allowed_updates=["callback_query"]`
    );
    const data = await res.json();
    if (!data.ok || !data.result?.length) return [];

    const decisions = [];

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      const cb = update.callback_query;
      if (!cb) continue;

      const [decision, actionId] = cb.data.split(':');
      if (decision === 'approve' || decision === 'reject') {
        decisions.push({ actionId, decision });
      }

      // Acknowledge the button tap (removes loading spinner in Telegram)
      await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ callback_query_id: cb.id }),
      });
    }

    return decisions;
  } catch {
    return [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
