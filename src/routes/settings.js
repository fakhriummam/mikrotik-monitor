const express = require('express');
const { db, getSettings, setSetting, audit } = require('../db');
const { sendTelegram } = require('../telegram');

const r = express.Router();
const KEYS = ['telegram_token', 'telegram_chat_id', 'alert_cpu', 'alert_mem', 'alert_cooldown_min', 'hotspot_name'];

r.get('/', (req, res) => {
  const s = getSettings();
  const out = {};
  for (const k of KEYS) out[k] = s[k] ?? '';
  // jangan kirim token utuh ke browser
  out.telegram_token_set = !!s.telegram_token;
  out.telegram_token = s.telegram_token ? s.telegram_token.slice(0, 6) + '…' : '';
  res.json(out);
});

r.put('/', (req, res) => {
  const b = req.body || {};
  for (const k of ['alert_cpu', 'alert_mem']) {
    if (b[k] !== undefined && !(Number(b[k]) >= 1 && Number(b[k]) <= 100)) return res.status(400).json({ error: 'Ambang harus 1–100%' });
  }
  if (b.alert_cooldown_min !== undefined && !(Number(b.alert_cooldown_min) >= 0)) return res.status(400).json({ error: 'Cooldown tidak valid' });
  for (const k of KEYS) {
    if (b[k] === undefined) continue;
    if (k === 'telegram_token' && (b[k] === '' || String(b[k]).includes('…'))) continue; // tidak diubah
    setSetting(k, String(b[k]).trim());
  }
  if (b.telegram_token_clear) setSetting('telegram_token', '');
  audit(req.session.user.username, null, 'settings.update', Object.keys(b).filter((k) => k !== 'telegram_token'));
  res.json({ ok: true });
});

r.post('/telegram-test', async (req, res) => {
  const result = await sendTelegram('✅ <b>MikroTik Monitor</b>\nTes notifikasi berhasil. Alert akan dikirim ke chat ini.');
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

r.get('/alerts', (req, res) => {
  res.json(db.prepare('SELECT a.*, r.name AS router_name FROM alerts_log a LEFT JOIN routers r ON r.id = a.router_id ORDER BY a.ts DESC LIMIT 100').all());
});

module.exports = r;
