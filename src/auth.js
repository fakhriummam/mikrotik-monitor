const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');

const router = express.Router();

// pembatas percobaan login sederhana (per IP)
const attempts = new Map();
function tooMany(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60000) { attempts.delete(ip); return false; }
  return a.count >= 10;
}

router.post('/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.' });
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    const a = attempts.get(ip) || { count: 0, first: Date.now() };
    a.count++; attempts.set(ip, a);
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  attempts.delete(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Gagal membuat sesi' });
    req.session.user = { id: u.id, username: u.username };
    audit(u.username, null, 'login', { ip });
    res.json({ ok: true, user: req.session.user });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Belum login' });
  res.json({ user: req.session.user });
});

router.post('/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(String(oldPassword || ''), u.password_hash)) return res.status(400).json({ error: 'Password lama salah' });
  if (String(newPassword || '').length < 6) return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 10), u.id);
  audit(u.username, null, 'password.change', '');
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Silakan login terlebih dahulu' });
}

module.exports = { authRouter: router, requireAuth };
