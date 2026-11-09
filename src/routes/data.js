const express = require('express');
const { db, audit } = require('../db');
const poller = require('../poller');

const r = express.Router({ mergeParams: true });
const W = (req) => poller.getWorker(req.params.id);
const user = (req) => req.session.user.username;

r.get('/stats', (req, res) => {
  const w = W(req);
  res.json({ ...w.summary(), interfaces: w.last ? w.last.interfaces : [], traffic: w.last ? w.last.traffic : [] });
});

const RANGES = { '1h': [3600e3, 60e3], '24h': [86400e3, 10 * 60e3], '7d': [7 * 86400e3, 60 * 60e3], '30d': [30 * 86400e3, 4 * 3600e3] };

r.get('/history', (req, res) => {
  const id = Number(req.params.id);
  const [span, bucket] = RANGES[req.query.range] || RANGES['24h'];
  const since = Date.now() - span;
  const samples = db.prepare(`
    SELECT (ts / ?) * ? AS t, AVG(cpu) cpu, AVG(mem_used * 100.0 / mem_total) mem, AVG(temp) temp,
           MAX(hotspot_active) hotspot, MAX(ppp_active) ppp
    FROM samples WHERE router_id = ? AND ts >= ? GROUP BY t ORDER BY t`).all(bucket, bucket, id, since);
  const ifaces = db.prepare('SELECT DISTINCT iface FROM traffic_samples WHERE router_id = ? AND ts >= ?').all(id, since).map((x) => x.iface);
  const iface = req.query.iface && ifaces.includes(req.query.iface) ? req.query.iface : ifaces[0];
  const traffic = iface ? db.prepare(`
    SELECT (ts / ?) * ? AS t, AVG(rx_bps) rx, AVG(tx_bps) tx, MAX(rx_bps) rx_max, MAX(tx_bps) tx_max
    FROM traffic_samples WHERE router_id = ? AND iface = ? AND ts >= ? GROUP BY t ORDER BY t`).all(bucket, bucket, id, iface, since) : [];
  res.json({ samples, traffic, ifaces, iface });
});

r.get('/hotspot-active', async (req, res) => {
  res.json(await W(req).exec('/ip/hotspot/active/print'));
});
r.post('/hotspot-active/kick', async (req, res) => {
  const { itemId, label } = req.body || {};
  await W(req).exec('/ip/hotspot/active/remove', { '.id': String(itemId) });
  audit(user(req), req.params.id, 'hotspot.kick', { user: label });
  res.json({ ok: true });
});

r.get('/ppp-active', async (req, res) => {
  res.json(await W(req).exec('/ppp/active/print'));
});
r.post('/ppp-active/kick', async (req, res) => {
  const { itemId, label } = req.body || {};
  await W(req).exec('/ppp/active/remove', { '.id': String(itemId) });
  audit(user(req), req.params.id, 'ppp.kick', { user: label });
  res.json({ ok: true });
});

r.get('/dhcp-leases', async (req, res) => {
  res.json(await W(req).exec('/ip/dhcp-server/lease/print'));
});

r.get('/logs', async (req, res) => {
  const logs = await W(req).exec('/log/print');
  res.json(logs.slice(-300).reverse());
});

r.get('/alerts', (req, res) => {
  res.json(db.prepare('SELECT * FROM alerts_log WHERE router_id = ? ORDER BY ts DESC LIMIT 200').all(req.params.id));
});

r.get('/audit', (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log WHERE router_id = ? ORDER BY ts DESC LIMIT 200').all(req.params.id));
});

/** Daftar device yang terhubung (gabungan DHCP + hotspot + PPPoE) untuk pemilih target bandwidth */
r.get('/devices', async (req, res) => {
  const w = W(req);
  const [leases, hs, ppp] = await Promise.all([
    w.exec('/ip/dhcp-server/lease/print').catch(() => []),
    w.exec('/ip/hotspot/active/print').catch(() => []),
    w.exec('/ppp/active/print').catch(() => []),
  ]);
  const out = [];
  for (const l of leases) if (l.address) out.push({ ip: l.address, label: l['host-name'] || l['mac-address'] || '', mac: l['mac-address'], source: 'DHCP' });
  for (const h of hs) if (h.address) out.push({ ip: h.address, label: h.user, mac: h['mac-address'], source: 'Hotspot' });
  for (const p of ppp) if (p.address) out.push({ ip: p.address, label: p.name, mac: p['caller-id'], source: 'PPPoE' });
  res.json(out);
});

module.exports = r;
