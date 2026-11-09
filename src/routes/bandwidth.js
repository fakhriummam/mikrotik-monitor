const express = require('express');
const { db, audit } = require('../db');
const poller = require('../poller');
const bw = require('../bandwidth');

const r = express.Router({ mergeParams: true });
const W = (req) => poller.getWorker(req.params.id);
const user = (req) => req.session.user.username;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/* ---------- Simple Queue ---------- */

r.get('/queues', async (req, res) => {
  const qs = await W(req).exec('/queue/simple/print');
  res.json(qs.map((q) => ({ ...q, managed: String(q.comment || '').startsWith('mtmon:') })));
});

// Tambah queue limit (subnet / device) secara langsung
r.post('/queues', async (req, res) => {
  const rule = bw.validateRule({ ...req.body, type: 'limit' });
  await bw.applyRules(W(req), [rule], 'manual');
  audit(user(req), req.params.id, 'queue.add', bw.describeRule(rule));
  res.json({ ok: true });
});

// Fokus / prioritaskan satu device
r.post('/queues/focus', async (req, res) => {
  const rule = bw.validateRule({ ...req.body, type: 'focus' });
  await bw.applyRules(W(req), [rule], `focus:${rule.name}`);
  audit(user(req), req.params.id, 'queue.focus', bw.describeRule(rule));
  res.json({ ok: true });
});

// Hapus satu grup fokus (induk + child) sekaligus
r.delete('/queues/focus/:name', async (req, res) => {
  const w = W(req);
  const qs = await w.exec('/queue/simple/print');
  const tag = `mtmon:focus:${req.params.name}`;
  const ids = qs.filter((q) => q.comment === tag).map((q) => q['.id']);
  if (!ids.length) throw bad('Grup fokus tidak ditemukan');
  await bw.revertChanges(w, ids, []);
  audit(user(req), req.params.id, 'queue.focus.remove', req.params.name);
  res.json({ ok: true });
});

r.put('/queues/:qid', async (req, res) => {
  const b = req.body || {};
  const p = { '.id': req.params.qid };
  if (b.maxLimit !== undefined) p['max-limit'] = bw.normRate(b.maxLimit, 'Max limit') || '0/0';
  if (b.limitAt !== undefined) p['limit-at'] = bw.normRate(b.limitAt, 'Limit-at') || '0/0';
  if (b.target !== undefined) p.target = bw.normTarget(b.target);
  if (b.priority !== undefined) {
    const n = Number(b.priority);
    if (!(n >= 1 && n <= 8)) throw bad('Priority harus 1–8');
    p.priority = `${n}/${n}`;
  }
  await W(req).exec('/queue/simple/set', p);
  audit(user(req), req.params.id, 'queue.edit', { id: req.params.qid, name: b.label, ...p });
  res.json({ ok: true });
});

r.post('/queues/:qid/:action', async (req, res) => {
  if (!['enable', 'disable'].includes(req.params.action)) throw bad('Aksi tidak dikenal');
  await W(req).exec(`/queue/simple/${req.params.action}`, { '.id': req.params.qid });
  audit(user(req), req.params.id, `queue.${req.params.action}`, { id: req.params.qid, name: (req.body || {}).label });
  res.json({ ok: true });
});

r.delete('/queues/:qid', async (req, res) => {
  await W(req).exec('/queue/simple/remove', { '.id': req.params.qid });
  audit(user(req), req.params.id, 'queue.delete', { id: req.params.qid, name: req.query.label });
  res.json({ ok: true });
});

/* ---------- Profil Mode Event ---------- */

function parseProfileBody(body) {
  const name = String((body || {}).name || '').trim();
  if (!name) throw bad('Nama profil wajib diisi');
  const rules = Array.isArray(body.rules) ? body.rules : [];
  if (!rules.length) throw bad('Profil harus punya minimal 1 aturan');
  const normalized = rules.map(bw.validateRule);
  const names = normalized.filter((x) => x.name).map((x) => x.name);
  if (new Set(names).size !== names.length) throw bad('Nama queue dalam satu profil tidak boleh sama');
  return { name, rules: normalized };
}

r.get('/bw-profiles', (req, res) => {
  const rows = db.prepare('SELECT * FROM bw_profiles WHERE router_id = ? ORDER BY name').all(req.params.id);
  res.json(rows.map((p) => {
    const rules = JSON.parse(p.rules_json);
    return { id: p.id, name: p.name, rules, summary: rules.map(bw.describeRule) };
  }));
});

r.post('/bw-profiles', (req, res) => {
  const { name, rules } = parseProfileBody(req.body);
  const info = db.prepare('INSERT INTO bw_profiles(router_id, name, rules_json) VALUES (?, ?, ?)').run(req.params.id, name, JSON.stringify(rules));
  audit(user(req), req.params.id, 'event.profile.add', { name });
  res.json({ ok: true, id: info.lastInsertRowid });
});

r.put('/bw-profiles/:pid', (req, res) => {
  const { name, rules } = parseProfileBody(req.body);
  const active = db.prepare("SELECT 1 FROM bw_activations WHERE profile_id = ? AND status = 'active'").get(req.params.pid);
  if (active) throw bad('Profil sedang aktif. Kembalikan normal dulu sebelum mengedit.');
  db.prepare('UPDATE bw_profiles SET name = ?, rules_json = ? WHERE id = ? AND router_id = ?').run(name, JSON.stringify(rules), req.params.pid, req.params.id);
  audit(user(req), req.params.id, 'event.profile.edit', { name });
  res.json({ ok: true });
});

r.delete('/bw-profiles/:pid', (req, res) => {
  const active = db.prepare("SELECT 1 FROM bw_activations WHERE profile_id = ? AND status IN ('active','scheduled')").get(req.params.pid);
  if (active) throw bad('Profil sedang aktif/terjadwal. Kembalikan normal / batalkan dulu.');
  db.prepare('DELETE FROM bw_profiles WHERE id = ? AND router_id = ?').run(req.params.pid, req.params.id);
  audit(user(req), req.params.id, 'event.profile.delete', { id: req.params.pid });
  res.json({ ok: true });
});

r.post('/bw-profiles/:pid/activate', async (req, res) => {
  const p = bw.getProfile(req.params.pid);
  if (String(p.router_id) !== String(req.params.id)) throw bad('Profil bukan milik router ini');
  const b = req.body || {};
  const durationMin = b.durationMin ? Number(b.durationMin) : null;
  if (durationMin !== null && !(durationMin > 0 && durationMin <= 60 * 24 * 30)) throw bad('Durasi tidak valid');
  const a = await bw.activate(p.id, { durationMin, startAt: b.startAt || null, user: user(req) });
  res.json({ ok: true, activation: a });
});

r.get('/events', (req, res) => {
  const rows = db.prepare(`SELECT a.id, a.profile_id, a.starts_at, a.ends_at, a.status, p.name AS profile_name
    FROM bw_activations a JOIN bw_profiles p ON p.id = a.profile_id WHERE a.router_id = ? ORDER BY a.id DESC LIMIT 30`).all(req.params.id);
  res.json(rows);
});

r.post('/events/:aid/revert', async (req, res) => {
  const a = db.prepare('SELECT router_id FROM bw_activations WHERE id = ?').get(req.params.aid);
  if (!a || String(a.router_id) !== String(req.params.id)) throw bad('Aktivasi tidak ditemukan');
  await bw.revert(Number(req.params.aid), { user: user(req) });
  res.json({ ok: true });
});

module.exports = r;
