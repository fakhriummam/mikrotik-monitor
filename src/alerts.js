const { db, getSettings } = require('./db');
const { sendTelegram } = require('./telegram');

const lastSent = new Map(); // `${routerId}:${key}` -> ts
let io = null;

const ICON = { down: '🔴', up: '🟢', cpu: '🔥', mem: '🧠', iface_down: '⚠️', iface_up: '✅', event_on: '🎉', event_off: '🔁', info: 'ℹ️' };

function setIo(socketIo) { io = socketIo; }

/**
 * Catat alert dan kirim ke Telegram.
 * opts.cooldownKey: jika diisi, alert dengan key sama tidak dikirim ulang sebelum cooldown habis.
 */
async function raise(router, type, message, opts = {}) {
  const now = Date.now();
  if (opts.cooldownKey) {
    const mins = Number(getSettings().alert_cooldown_min) || 10;
    const k = `${router.id}:${opts.cooldownKey}`;
    if (lastSent.has(k) && now - lastSent.get(k) < mins * 60000) return;
    lastSent.set(k, now);
  }
  const info = db.prepare('INSERT INTO alerts_log(router_id, ts, type, message) VALUES (?, ?, ?, ?)').run(router.id, now, type, message);
  if (io) io.to('auth').emit('alert', { router_id: router.id, router: router.name, ts: now, type, message });
  const text = `${ICON[type] || '•'} <b>${escapeHtml(router.name)}</b>\n${escapeHtml(message)}\n<i>${new Date(now).toLocaleString('id-ID')}</i>`;
  const r = await sendTelegram(text);
  if (r.ok) db.prepare('UPDATE alerts_log SET sent = 1 WHERE id = ?').run(info.lastInsertRowid);
  else if (!/belum diatur/.test(r.error)) console.warn('[telegram]', r.error);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

module.exports = { raise, setIo };
