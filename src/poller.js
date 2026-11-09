const config = require('./config');
const { db, getSettings } = require('./db');
const { decrypt } = require('./crypto');
const { createClient } = require('./routeros/client');
const alerts = require('./alerts');

const SAMPLE_EVERY = 60000;
const FAIL_THRESHOLD = 3;
const HIGH_THRESHOLD = 3;

const workers = new Map(); // routerId -> worker
let io = null;

function loadRouter(id) {
  return db.prepare('SELECT * FROM routers WHERE id = ?').get(id);
}

function toClientOpts(r) {
  return { name: r.name, host: r.host, port: r.port, username: r.username, password: decrypt(r.password_enc), useSsl: !!r.use_ssl };
}

const num = (v) => (v === undefined || v === '' ? null : Number(v));

class Worker {
  constructor(router) {
    this.router = router;
    this.client = createClient(toClientOpts(router));
    this.online = false;
    this.everOnline = false;
    this.downAlerted = false;
    this.failCount = 0;
    this.lastError = null;
    this.last = null;
    this.ifaceRunning = {};
    this.high = { cpu: 0, mem: 0 };
    this.lastSampleTs = 0;
    this.stopped = false;
    this.busy = false;
    this.timer = setInterval(() => this.poll(), config.pollInterval);
    this.poll();
  }

  async exec(cmd, params, query) {
    try {
      return await this.client.exec(cmd, params, query);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const e = new Error(msg);
      // error dari RouterOS (mis. "already have such name") = kesalahan input -> 422; error koneksi -> 502
      e.status = /timed? ?out|ECONN|closed|socket|connect|EHOST|ENET/i.test(msg) || !this.client.connected ? 502 : 422;
      throw e;
    }
  }

  summary() {
    const l = this.last || {};
    return {
      id: this.router.id,
      name: this.router.name,
      host: this.router.host,
      enabled: !!this.router.enabled,
      online: this.online,
      lastError: this.lastError,
      ts: l.ts || null,
      cpu: l.cpu ?? null,
      memUsed: l.memUsed ?? null,
      memTotal: l.memTotal ?? null,
      temp: l.temp ?? null,
      uptime: l.uptime || null,
      version: l.version || null,
      board: l.board || null,
      hotspotActive: l.hotspotActive ?? null,
      pppActive: l.pppActive ?? null,
    };
  }

  async poll() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const [res] = await this.exec('/system/resource/print');
      let temp = null;
      try {
        const health = await this.exec('/system/health/print');
        const t = health.find((h) => /temperature/.test(h.name || '')) || health[0] || {};
        temp = num(t.value ?? t.temperature ?? t['cpu-temperature']);
      } catch { /* tidak semua board punya sensor */ }

      const ifaces = await this.exec('/interface/print');
      const active = ifaces.filter((i) => i.running === 'true' && i.disabled !== 'true').map((i) => i.name);
      let traffic = [];
      if (active.length) {
        const t = await this.exec('/interface/monitor-traffic', { interface: active.join(','), once: '' });
        traffic = t.map((x) => ({ name: x.name, rx: num(x['rx-bits-per-second']) || 0, tx: num(x['tx-bits-per-second']) || 0 }));
      }
      const [hs, ppp] = await Promise.all([
        this.exec('/ip/hotspot/active/print').catch(() => null),
        this.exec('/ppp/active/print').catch(() => null),
      ]);

      const memTotal = num(res['total-memory']);
      const memUsed = memTotal - num(res['free-memory']);
      this.last = {
        ts: Date.now(),
        cpu: num(res['cpu-load']),
        memUsed, memTotal, temp,
        uptime: res.uptime,
        version: res.version,
        board: res['board-name'],
        hotspotActive: hs ? hs.length : null,
        pppActive: ppp ? ppp.length : null,
        interfaces: ifaces.map((i) => ({ name: i.name, type: i.type, running: i.running === 'true', disabled: i.disabled === 'true' })),
        traffic,
      };

      const wasOnline = this.online;
      this.online = true;
      this.everOnline = true;
      this.failCount = 0;
      this.lastError = null;
      if (this.downAlerted) {
        this.downAlerted = false;
        alerts.raise(this.router, 'up', 'Router kembali ONLINE');
      }
      this.checkThresholds(ifaces);
      this.saveSample();
      if (!wasOnline) this.emitSummary();
      this.emit();
    } catch (err) {
      this.failCount++;
      this.lastError = err.message || String(err);
      this.online = false;
      await this.client.close().catch(() => {});
      if (this.failCount >= FAIL_THRESHOLD && !this.downAlerted) {
        this.downAlerted = true;
        alerts.raise(this.router, 'down', `Router OFFLINE / tidak bisa dihubungi: ${this.lastError}`);
      }
      this.emitSummary();
      if (io) io.to(`router:${this.router.id}`).emit('stats', this.summary());
    } finally {
      this.busy = false;
    }
  }

  checkThresholds(ifaces) {
    const s = getSettings();
    const l = this.last;
    const cpuMax = Number(s.alert_cpu) || 90;
    const memMax = Number(s.alert_mem) || 90;
    const memPct = l.memTotal ? (l.memUsed / l.memTotal) * 100 : 0;

    this.high.cpu = l.cpu >= cpuMax ? this.high.cpu + 1 : 0;
    this.high.mem = memPct >= memMax ? this.high.mem + 1 : 0;
    if (this.high.cpu === HIGH_THRESHOLD) alerts.raise(this.router, 'cpu', `CPU tinggi: ${l.cpu}% (ambang ${cpuMax}%)`, { cooldownKey: 'cpu' });
    if (this.high.mem === HIGH_THRESHOLD) alerts.raise(this.router, 'mem', `RAM tinggi: ${memPct.toFixed(0)}% (ambang ${memMax}%)`, { cooldownKey: 'mem' });

    const watch = String(this.router.watch_ifaces || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const i of ifaces) {
      if (!watch.includes(i.name)) continue;
      const running = i.running === 'true' && i.disabled !== 'true';
      const prev = this.ifaceRunning[i.name];
      if (prev !== undefined && prev !== running) {
        alerts.raise(this.router, running ? 'iface_up' : 'iface_down', `Interface ${i.name} ${running ? 'kembali UP' : 'DOWN'}`);
      }
      this.ifaceRunning[i.name] = running;
    }
  }

  saveSample() {
    const l = this.last;
    if (l.ts - this.lastSampleTs < SAMPLE_EVERY) return;
    this.lastSampleTs = l.ts;
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO samples(router_id, ts, cpu, mem_used, mem_total, temp, uptime, hotspot_active, ppp_active) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(this.router.id, l.ts, l.cpu, l.memUsed, l.memTotal, l.temp, l.uptime, l.hotspotActive, l.pppActive);
      const ins = db.prepare('INSERT INTO traffic_samples(router_id, ts, iface, rx_bps, tx_bps) VALUES (?,?,?,?,?)');
      for (const t of l.traffic) ins.run(this.router.id, l.ts, t.name, Math.round(t.rx), Math.round(t.tx));
    });
    tx();
  }

  emit() {
    if (!io) return;
    io.to(`router:${this.router.id}`).emit('stats', { ...this.summary(), interfaces: this.last.interfaces, traffic: this.last.traffic });
    io.to('dashboard').emit('summary', this.summary());
  }

  emitSummary() {
    if (io) io.to('dashboard').emit('summary', this.summary());
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.client.close().catch(() => {});
  }
}

async function startRouter(id) {
  await stopRouter(id);
  const r = loadRouter(id);
  if (!r || !r.enabled) return;
  workers.set(id, new Worker(r));
}

async function stopRouter(id) {
  const w = workers.get(id);
  if (w) { workers.delete(id); await w.stop(); }
}

function getWorker(id) {
  const w = workers.get(Number(id));
  if (!w) {
    const err = new Error('Router tidak aktif / tidak ditemukan');
    err.status = 404;
    throw err;
  }
  return w;
}

function allSummaries() {
  return db.prepare('SELECT * FROM routers ORDER BY name').all().map((r) => {
    const w = workers.get(r.id);
    return w ? w.summary() : { id: r.id, name: r.name, host: r.host, enabled: !!r.enabled, online: false, lastError: r.enabled ? 'Memulai…' : 'Dinonaktifkan' };
  });
}

function startAll(socketIo) {
  io = socketIo;
  for (const r of db.prepare('SELECT id FROM routers WHERE enabled = 1').all()) startRouter(r.id);
  // retensi riwayat
  const purge = () => {
    const cut = Date.now() - config.retentionDays * 86400000;
    db.prepare('DELETE FROM samples WHERE ts < ?').run(cut);
    db.prepare('DELETE FROM traffic_samples WHERE ts < ?').run(cut);
    db.prepare('DELETE FROM alerts_log WHERE ts < ?').run(cut);
  };
  purge();
  setInterval(purge, 6 * 3600000);
}

module.exports = { startAll, startRouter, stopRouter, getWorker, allSummaries, toClientOpts };
