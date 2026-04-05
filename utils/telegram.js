// ─── Telegram Notifier ────────────────────────────────────────────────────────
// FYI-only notifications. The AI acts on its own — Telegram just keeps you
// informed so you can glance at what's happening without opening the extension.
//
// Setup (once):
//   1. Message @BotFather → /newbot → get bot token
//   2. Start a chat with your bot
//   3. Visit https://api.telegram.org/bot{TOKEN}/getUpdates → grab chat_id
//   4. Paste both into extension Settings

const TELEGRAM_API = 'https://api.telegram.org';

// ─── Core Send ────────────────────────────────────────────────────────────────
export async function sendMessage({ botToken, chatId, text, parseMode = 'HTML' }) {
  if (!botToken || !chatId) return { ok: false, error: 'Telegram not configured.' };

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       text.slice(0, 4096),
        parse_mode: parseMode,
      }),
    });
    const data = await res.json();
    return data.ok ? { ok: true } : { ok: false, error: data.description };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Post Idea ────────────────────────────────────────────────────────────────
export async function notifyPostIdea({ botToken, chatId, idea }) {
  return await sendMessage({
    botToken, chatId,
    text: `✈️ <b>Post Idea</b>\n\n${escapeHtml(idea)}`,
  });
}

// ─── Golden Hour Update ───────────────────────────────────────────────────────
export async function notifyGoldenHour({ botToken, chatId, postUrl, commentCount, repliesSent }) {
  return await sendMessage({
    botToken, chatId,
    text:
      `⏱ <b>Golden Hour Update</b>\n\n` +
      `${commentCount} new comment(s) on your post.\n` +
      `${repliesSent} repl${repliesSent === 1 ? 'y' : 'ies'} sent automatically.\n\n` +
      `<a href="${postUrl}">View post</a>`,
  });
}

// ─── Daily Digest ─────────────────────────────────────────────────────────────
// Sent once per day summarising everything the AI did.
export async function sendDailyDigest({ botToken, chatId, counts, topActions, postIdeas }) {
  const lines = [
    `📊 <b>Daily Digest — Aviation Manager</b>`,
    ``,
    `<b>Today's activity:</b>`,
    `💬 Comments posted: ${counts.comments}`,
    `➕ Accounts followed: ${counts.follows}`,
    `❤️ Posts liked: ${counts.likes}`,
    ``,
  ];

  if (topActions?.length) {
    lines.push(`<b>Highlights:</b>`);
    topActions.slice(0, 5).forEach(a => lines.push(`• ${escapeHtml(a)}`));
    lines.push('');
  }

  if (postIdeas?.length) {
    lines.push(`<b>Post ideas for tomorrow:</b>`);
    postIdeas.slice(0, 3).forEach((idea, i) => lines.push(`${i + 1}. ${escapeHtml(idea)}`));
  }

  return await sendMessage({ botToken, chatId, text: lines.join('\n') });
}

// ─── Generic Alert ────────────────────────────────────────────────────────────
export async function notifyAlert({ botToken, chatId, title, body: bodyText }) {
  return await sendMessage({
    botToken, chatId,
    text: `🔔 <b>${escapeHtml(title)}</b>\n\n${escapeHtml(bodyText)}`,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
