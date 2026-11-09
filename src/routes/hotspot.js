const express = require('express');
const crypto = require('crypto');
const { audit } = require('../db');
const poller = require('../poller');
const { normRate } = require('../bandwidth');

const r = express.Router({ mergeParams: true });
const W = (req) => poller.getWorker(req.params.id);
const user = (req) => req.session.user.username;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const BATCH_PREFIX = 'mtmon-batch:';

/** "2G" / "500M" / "1024" -> jumlah byte (string). Kosong -> undefined */
function parseBytes(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '0') return s === '0' ? '0' : undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgGtT]?)[bB]?$/.exec(s);
  if (!m) throw bad(`Kuota tidak valid: "${v}" (contoh: 500M, 2G)`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return String(Math.round(Number(m[1]) * mult));
}
/** "3h", "1d", "30m", "1d12h", "01:00:00" -> divalidasi apa adanya */
function parseDuration(v, field = 'Batas waktu') {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  if (/^(\d+[wdhms])+$/.test(s) || /^\d{1,2}:\d{2}:\d{2}$/.test(s) || s === '0s') return s;
  throw bad(`${field} tidak valid: "${v}" (contoh: 30m, 3h, 1d)`);
}

function userParams(b, isNew) {
  const p = {};
  if (isNew || b.name !== undefined) {
    p.name = String(b.name || '').trim();
    if (!/^[^\s'"\\]{1,64}$/.test(p.name)) throw bad('Username wajib diisi (tanpa spasi/tanda kutip)');
  }
  if (b.password !== undefined) p.password = String(b.password);
  if (b.profile !== undefined) p.profile = String(b.profile || 'default');
  if (b.server !== undefined) p.server = String(b.server || 'all');
  if (b.limitUptime !== undefined) p['limit-uptime'] = parseDuration(b.limitUptime) ?? '0s';
  if (b.limitBytes !== undefined) p['limit-bytes-total'] = parseBytes(b.limitBytes) ?? '0';
  if (b.mac !== undefined) {
    const mac = String(b.mac || '').trim().toUpperCase();
    if (mac && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) throw bad('Format MAC tidak valid (contoh: AA:BB:CC:DD:EE:FF)');
    p['mac-address'] = mac || '00:00:00:00:00:00';
  }
  if (b.comment !== undefined) p.comment = String(b.comment || '');
  return p;
}

/* ---------- User hotspot ---------- */

r.get('/hotspot-users', async (req, res) => {
  const w = W(req);
  const [users, active] = await Promise.all([w.exec('/ip/hotspot/user/print'), w.exec('/ip/hotspot/active/print').catch(() => [])]);
  const online = new Set(active.map((a) => a.user));
  res.json(users.map((u) => ({ ...u, online: online.has(u.name) })));
});

r.post('/hotspot-users', async (req, res) => {
  const p = userParams(req.body || {}, true);
  await W(req).exec('/ip/hotspot/user/add', p);
  audit(user(req), req.params.id, 'hotspot.user.add', { name: p.name, profile: p.profile });
  res.json({ ok: true });
});

r.put('/hotspot-users/:uid', async (req, res) => {
  const p = userParams(req.body || {}, false);
  await W(req).exec('/ip/hotspot/user/set', { '.id': req.params.uid, ...p });
  audit(user(req), req.params.id, 'hotspot.user.edit', { id: req.params.uid, name: p.name });
  res.json({ ok: true });
});

r.post('/hotspot-users/:uid/:action', async (req, res) => {
  const map = { enable: 'enable', disable: 'disable', reset: 'reset-counters' };
  const cmd = map[req.params.action];
  if (!cmd) throw bad('Aksi tidak dikenal');
  await W(req).exec(`/ip/hotspot/user/${cmd}`, { '.id': req.params.uid });
  audit(user(req), req.params.id, `hotspot.user.${req.params.action}`, { id: req.params.uid, name: (req.body || {}).label });
  res.json({ ok: true });
});

r.delete('/hotspot-users/:uid', async (req, res) => {
  await W(req).exec('/ip/hotspot/user/remove', { '.id': req.params.uid });
  audit(user(req), req.params.id, 'hotspot.user.delete', { id: req.params.uid, name: req.query.label });
  res.json({ ok: true });
});

/* ---------- Voucher massal ---------- */

const CHARSETS = {
  num: '23456789',
  lower: 'abcdefghjkmnpqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  alnum: 'abcdefghjkmnpqrstuvwxyz23456789',
  mixed: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789',
};
function randStr(len, set) {
  const chars = CHARSETS[set] || CHARSETS.alnum;
  let s = '';
  for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

r.post('/hotspot-users/generate', async (req, res) => {
  const b = req.body || {};
  const count = Number(b.count);
  if (!(Number.isInteger(count) && count >= 1 && count <= 500)) throw bad('Jumlah voucher 1–500');
  const len = Number(b.length) || 6;
  if (len < 3 || len > 16) throw bad('Panjang kode 3–16 karakter');
  const prefix = String(b.prefix || '').trim();
  if (!/^[\w-]{0,10}$/.test(prefix)) throw bad('Prefix hanya huruf/angka, maks 10');
  const mode = b.mode === 'userpass' ? 'userpass' : 'same'; // same = username = password
  const base = userParams({ profile: b.profile, server: b.server, limitUptime: b.limitUptime, limitBytes: b.limitBytes }, false);
  const now = new Date();
  const batch = `${now.toISOString().slice(0, 10)}-${now.toTimeString().slice(0, 8).replace(/:/g, '')}`;
  const comment = `${BATCH_PREFIX}${batch}${b.note ? ' ' + String(b.note).replace(/[\r\n]/g, ' ').slice(0, 40) : ''}`;

  const w = W(req);
  const existing = new Set((await w.exec('/ip/hotspot/user/print')).map((u) => u.name));
  const created = [];
  const errors = [];
  let guard = 0;
  while (created.length < count && guard++ < count * 5) {
    const name = prefix + randStr(len, b.charset);
    if (existing.has(name)) continue;
    const password = mode === 'same' ? name : randStr(len, b.charset);
    try {
      await w.exec('/ip/hotspot/user/add', { ...base, name, password, comment });
      existing.add(name);
      created.push({ name, password });
    } catch (e) {
      errors.push(e.message);
      if (errors.length > 5) break;
    }
  }
  audit(user(req), req.params.id, 'hotspot.voucher.generate', { batch, count: created.length, profile: base.profile });
  res.json({ ok: created.length > 0, batch, comment, users: created, errors });
});

r.get('/hotspot-batches', async (req, res) => {
  const users = await W(req).exec('/ip/hotspot/user/print');
  const batches = new Map();
  for (const u of users) {
    const c = u.comment || '';
    if (!c.startsWith(BATCH_PREFIX)) continue;
    const id = c.slice(BATCH_PREFIX.length).split(' ')[0];
    const b = batches.get(id) || { batch: id, note: c.slice(BATCH_PREFIX.length + id.length).trim(), profile: u.profile, count: 0, used: 0, users: [] };
    b.count++;
    if (u.uptime && u.uptime !== '0s') b.used++;
    b.users.push({ name: u.name, password: u.password, profile: u.profile, 'limit-uptime': u['limit-uptime'], 'limit-bytes-total': u['limit-bytes-total'], uptime: u.uptime });
    batches.set(id, b);
  }
  res.json([...batches.values()].sort((a, b) => (a.batch < b.batch ? 1 : -1)));
});

r.delete('/hotspot-batches/:batch', async (req, res) => {
  const w = W(req);
  const tag = BATCH_PREFIX + req.params.batch;
  const users = (await w.exec('/ip/hotspot/user/print')).filter((u) => (u.comment || '') === tag || (u.comment || '').startsWith(tag + ' '));
  if (users.length) await w.exec('/ip/hotspot/user/remove', { '.id': users.map((u) => u['.id']).join(',') });
  audit(user(req), req.params.id, 'hotspot.voucher.delete-batch', { batch: req.params.batch, count: users.length });
  res.json({ ok: true, removed: users.length });
});

/* ---------- Profil user hotspot & server ---------- */

function profileParams(b, isNew) {
  const p = {};
  if (isNew || b.name !== undefined) {
    p.name = String(b.name || '').trim();
    if (!/^[\w.\-]{1,40}$/.test(p.name)) throw bad('Nama profil wajib diisi (tanpa spasi)');
  }
  if (b.rateLimit !== undefined) p['rate-limit'] = normRate(b.rateLimit, 'Rate limit') || '';
  if (b.sharedUsers !== undefined) {
    const n = Number(b.sharedUsers || 1);
    if (!(Number.isInteger(n) && n >= 1 && n <= 1000)) throw bad('Shared users harus angka ≥ 1');
    p['shared-users'] = String(n);
  }
  if (b.sessionTimeout !== undefined) p['session-timeout'] = parseDuration(b.sessionTimeout, 'Session timeout') ?? '0s';
  return p;
}

r.get('/hotspot-profiles', async (req, res) => {
  res.json(await W(req).exec('/ip/hotspot/user/profile/print'));
});
r.post('/hotspot-profiles', async (req, res) => {
  const p = profileParams(req.body || {}, true);
  await W(req).exec('/ip/hotspot/user/profile/add', p);
  audit(user(req), req.params.id, 'hotspot.profile.add', p);
  res.json({ ok: true });
});
r.put('/hotspot-profiles/:pid', async (req, res) => {
  const p = profileParams(req.body || {}, false);
  await W(req).exec('/ip/hotspot/user/profile/set', { '.id': req.params.pid, ...p });
  audit(user(req), req.params.id, 'hotspot.profile.edit', p);
  res.json({ ok: true });
});
r.delete('/hotspot-profiles/:pid', async (req, res) => {
  await W(req).exec('/ip/hotspot/user/profile/remove', { '.id': req.params.pid });
  audit(user(req), req.params.id, 'hotspot.profile.delete', { id: req.params.pid, name: req.query.label });
  res.json({ ok: true });
});

r.get('/hotspot-servers', async (req, res) => {
  res.json(await W(req).exec('/ip/hotspot/print').catch(() => []));
});

module.exports = r;
