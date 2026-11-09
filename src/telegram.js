const { getSettings } = require('./db');

async function sendTelegram(text, override = {}) {
  const s = getSettings();
  const token = override.token ?? s.telegram_token;
  const chatId = override.chatId ?? s.telegram_chat_id;
  if (!token || !chatId) return { ok: false, error: 'Token bot / Chat ID Telegram belum diatur' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) return { ok: false, error: body.description || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendTelegram };
