const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'monitor.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 8728,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  use_ssl INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  watch_ifaces TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS samples (
  router_id INTEGER NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  cpu REAL, mem_used INTEGER, mem_total INTEGER, temp REAL, uptime TEXT,
  hotspot_active INTEGER, ppp_active INTEGER
);
CREATE INDEX IF NOT EXISTS idx_samples ON samples(router_id, ts);
CREATE TABLE IF NOT EXISTS traffic_samples (
  router_id INTEGER NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  iface TEXT NOT NULL,
  rx_bps INTEGER, tx_bps INTEGER
);
CREATE INDEX IF NOT EXISTS idx_traffic ON traffic_samples(router_id, iface, ts);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS alerts_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  router_id INTEGER REFERENCES routers(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user TEXT,
  router_id INTEGER REFERENCES routers(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS bw_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  router_id INTEGER NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rules_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bw_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES bw_profiles(id) ON DELETE CASCADE,
  router_id INTEGER NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  snapshot_json TEXT,
  created_ids TEXT,
  status TEXT NOT NULL  -- scheduled | active | reverted | failed | cancelled
);
`);

const DEFAULT_SETTINGS = {
  telegram_token: '',
  telegram_chat_id: '',
  alert_cpu: '90',
  alert_mem: '90',
  alert_cooldown_min: '10',
  hotspot_name: 'Hotspot',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

if (!db.prepare('SELECT COUNT(*) c FROM users').get().c) {
  db.prepare('INSERT INTO users(username, password_hash) VALUES (?, ?)')
    .run(config.adminUser, bcrypt.hashSync(config.adminPass, 10));
  console.log(`[db] Admin awal dibuat: ${config.adminUser}`);
}

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value ?? ''));
}
function audit(user, routerId, action, detail) {
  db.prepare('INSERT INTO audit_log(ts, user, router_id, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), user || null, routerId || null, action, typeof detail === 'string' ? detail : JSON.stringify(detail ?? ''));
}

module.exports = { db, getSettings, setSetting, audit };
