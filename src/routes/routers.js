const express = require('express');
const { db, audit } = require('../db');
const { encrypt } = require('../crypto');
const poller = require('../poller');
const { createClient } = require('../routeros/client');
const { decrypt } = require('../crypto');

const r = express.Router();

function publicRow(row) {
  const { password_enc, ...rest } = row;
  return { ...rest, use_ssl: !!rest.use_ssl, enabled: !!rest.enabled };
}

function validate(body, isNew) {
  const name = String(body.name || '').trim();
  const host = String(body.host || '').trim();
  const username = String(body.username || '').trim();
  if (!name) throw Object.assign(new Error('Nama router wajib diisi'), { status: 400 });
  if (!/^[\w.\-:]+$/.test(host)) throw Object.assign(new Error('Host/IP tidak valid'), { status: 400 });
  if (!username) throw Object.assign(new Error('Username wajib diisi'), { status: 400 });
  if (isNew && body.password === undefined) throw Object.assign(new Error('Password wajib diisi'), { status: 400 });
  const useSsl = !!body.use_ssl;
  const port = Number(body.port) || (useSsl ? 8729 : 8728);
  if (port < 1 || port > 65535) throw Object.assign(new Error('Port tidak valid'), { status: 400 });
  const watch = String(body.watch_ifaces || '').split(',').map((x) => x.trim()).filter(Boolean).join(',');
  return { name, host, port, username, use_ssl: useSsl ? 1 : 0, enabled: body.enabled === false ? 0 : 1, watch_ifaces: watch };
}

r.get('/', (req, res) => {
  const rows = new Map(db.prepare('SELECT * FROM routers').all().map((x) => [x.id, publicRow(x)]));
  res.json(poller.allSummaries().map((s) => ({ ...rows.get(s.id), ...s })));
});

r.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Router tidak ditemukan' });
  const s = poller.allSummaries().find((x) => x.id === row.id);
  res.json({ ...publicRow(row), ...s });
});

r.post('/test', async (req, res) => {
  const b = req.body || {};
  let password = b.password;
  if ((password === undefined || password === '') && b.id) {
    const row = db.prepare('SELECT password_enc FROM routers WHERE id = ?').get(b.id);
    if (row) password = decrypt(row.password_enc);
  }
  const client = createClient({ host: String(b.host || '').trim(), port: b.port, username: b.username, password: password || '', useSsl: !!b.use_ssl });
  try {
    const [id] = await client.exec('/system/identity/print');
    const [res2] = await client.exec('/system/resource/print');
    res.json({ ok: true, identity: id && id.name, version: res2 && res2.version, board: res2 && res2['board-name'] });
  } catch (err) {
    res.status(400).json({ ok: false, error: `Gagal terhubung: ${err.message || err}` });
  } finally {
    client.close().catch(() => {});
  }
});

r.post('/', async (req, res) => {
  const v = validate(req.body || {}, true);
  const info = db.prepare('INSERT INTO routers(name, host, port, username, password_enc, use_ssl, enabled, watch_ifaces, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(v.name, v.host, v.port, v.username, encrypt(req.body.password || ''), v.use_ssl, v.enabled, v.watch_ifaces, Date.now());
  audit(req.session.user.username, info.lastInsertRowid, 'router.add', { name: v.name, host: v.host });
  await poller.startRouter(info.lastInsertRowid);
  res.json({ ok: true, id: info.lastInsertRowid });
});

r.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM routers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Router tidak ditemukan' });
  const v = validate(req.body || {}, false);
  const pw = req.body.password ? encrypt(req.body.password) : row.password_enc;
  db.prepare('UPDATE routers SET name=?, host=?, port=?, username=?, password_enc=?, use_ssl=?, enabled=?, watch_ifaces=? WHERE id=?')
    .run(v.name, v.host, v.port, v.username, pw, v.use_ssl, v.enabled, v.watch_ifaces, id);
  audit(req.session.user.username, id, 'router.edit', { name: v.name, host: v.host });
  await poller.startRouter(id);
  res.json({ ok: true });
});

r.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await poller.stopRouter(id);
  db.prepare('DELETE FROM routers WHERE id = ?').run(id);
  audit(req.session.user.username, null, 'router.delete', { id });
  res.json({ ok: true });
});

module.exports = r;
