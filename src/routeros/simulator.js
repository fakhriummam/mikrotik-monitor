/**
 * Router MikroTik palsu untuk demo/pengujian. API-nya sama dengan RosClient:
 * connect(), exec(cmd, params, query), close().
 * State disimpan di memori per host, sehingga perubahan (queue, user hotspot) bertahan selama proses hidup.
 * Host berakhiran "down.sim" selalu gagal konek (untuk menguji status offline).
 */
const states = new Map();

const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
const pick = (arr) => arr[rnd(0, arr.length)];
const mac = () => Array.from({ length: 6 }, () => rnd(0, 256).toString(16).padStart(2, '0')).join(':').toUpperCase();
const fmtUptime = (s) => {
  const w = Math.floor(s / 604800); s %= 604800;
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return `${w ? w + 'w' : ''}${d ? d + 'd' : ''}${h}h${m}m${s}s`;
};

class Table {
  constructor(rows = []) { this.seq = 1; this.rows = []; rows.forEach((r) => this.add(r)); }
  add(r) {
    const { 'place-before': before, ...rest } = r;
    const row = { '.id': '*' + (this.seq++).toString(16).toUpperCase(), disabled: 'false', ...rest };
    const idx = before ? this.rows.findIndex((x) => x['.id'] === before) : -1;
    if (idx >= 0) this.rows.splice(idx, 0, row); else this.rows.push(row);
    return row['.id'];
  }
  find(id) { return this.rows.find((r) => r['.id'] === id); }
  match(q) { return this.rows.filter((r) => Object.entries(q).every(([k, v]) => String(r[k]) === String(v))); }
  set(id, p) { const r = this.find(id); if (!r) throw new Error('no such item'); Object.assign(r, p); }
  remove(ids) { for (const id of String(ids).split(',')) this.rows = this.rows.filter((r) => r['.id'] !== id); }
}

function initState(name) {
  const names = ['andi', 'budi', 'citra', 'dewi', 'eko', 'fajar', 'gita', 'hadi', 'indah', 'joko', 'kiki', 'lina'];
  const devices = ['android-phone', 'iPhone', 'LAPTOP-OPERATOR', 'DESKTOP-KASIR', 'Galaxy-A54', 'MacBook-Pro', 'printer-hp', 'smart-tv', 'Redmi-Note'];
  const st = {
    name,
    boot: Date.now() - rnd(3600, 3600 * 24 * 20) * 1000,
    cpu: rnd(5, 30),
    memTotal: 1024 * 1024 * 1024,
    memUsed: rnd(200, 500) * 1024 * 1024,
    ifaces: [
      { name: 'ether1-wan', type: 'ether', base: 40e6 },
      { name: 'ether2-lan', type: 'ether', base: 30e6 },
      { name: 'bridge-hotspot', type: 'bridge', base: 20e6 },
      { name: 'wlan1', type: 'wlan', base: 8e6 },
      { name: 'pppoe-out1', type: 'pppoe-out', base: 5e6 },
    ].map((i) => ({ ...i, running: true, rx: i.base, tx: i.base / 4 })),
    leases: new Table(),
    hotspotActive: new Table(),
    pppActive: new Table(),
    queues: new Table(),
    hsUsers: new Table(),
    hsProfiles: new Table([
      { name: 'default', 'rate-limit': '', 'shared-users': '1', 'session-timeout': '' },
      { name: '1jam-2M', 'rate-limit': '1M/2M', 'shared-users': '1', 'session-timeout': '1h' },
      { name: 'harian-5M', 'rate-limit': '2M/5M', 'shared-users': '2', 'session-timeout': '1d' },
    ]),
    hsServers: new Table([{ name: 'hotspot1', interface: 'bridge-hotspot', profile: 'default' }]),
    logs: [],
  };
  for (let i = 0; i < 14; i++) {
    st.leases.add({ address: `192.168.10.${10 + i}`, 'mac-address': mac(), 'host-name': `${pick(devices)}-${i}`, server: 'dhcp-lan', status: 'bound', dynamic: 'true', 'expires-after': `${rnd(1, 59)}m` });
  }
  for (let i = 0; i < 6; i++) {
    const u = names[i];
    st.hsUsers.add({ name: u, password: '1234', profile: pick(['default', '1jam-2M', 'harian-5M']), server: 'all', 'limit-uptime': '', 'limit-bytes-total': '0', uptime: '0s', 'bytes-in': '0', 'bytes-out': '0', comment: '' });
    st.hotspotActive.add({ user: u, address: `10.5.50.${20 + i}`, 'mac-address': mac(), server: 'hotspot1', uptime: fmtUptime(rnd(60, 7200)), 'bytes-in': String(rnd(1e6, 5e8)), 'bytes-out': String(rnd(1e6, 5e7)), 'login-by': 'http-chap' });
  }
  for (let i = 0; i < 4; i++) {
    st.pppActive.add({ name: `pelanggan${i + 1}`, service: 'pppoe', 'caller-id': mac(), address: `10.10.0.${2 + i}`, uptime: fmtUptime(rnd(3600, 864000)), encoding: '' });
  }
  st.queues.add({ name: 'limit-tamu', target: '192.168.20.0/24', 'max-limit': '5M/10M', 'limit-at': '0/0', priority: '8/8', comment: 'dibuat manual' });
  const topics = ['system,info', 'hotspot,info,debug', 'dhcp,info', 'pppoe,ppp,info', 'interface,info'];
  const msgs = ['user admin logged in via api', 'andi (10.5.50.20): logged in', 'dhcp-lan assigned 192.168.10.15', 'pelanggan2: connected', 'ether2-lan link up (speed 1G, full duplex)'];
  for (let i = 0; i < 25; i++) {
    const j = rnd(0, topics.length);
    st.logs.push({ time: new Date(Date.now() - (25 - i) * 60000).toTimeString().slice(0, 8), topics: topics[j], message: msgs[j] });
  }
  return st;
}

function parseRate(v) {
  const m = /^([\d.]+)\s*([kKmMgG]?)$/.exec(String(v || '0').trim());
  if (!m) return 0;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase()] || 1);
}

function tick(st) {
  st.cpu = Math.max(1, Math.min(100, st.cpu + rnd(-8, 9)));
  st.memUsed = Math.max(150e6, Math.min(st.memTotal * 0.95, st.memUsed + rnd(-20, 21) * 1e6));
  for (const i of st.ifaces) {
    i.rx = Math.max(0, i.base * (0.4 + Math.random() * 1.2));
    i.tx = i.rx * (0.15 + Math.random() * 0.3);
  }
  for (const a of st.hotspotActive.rows) {
    a['bytes-in'] = String(Number(a['bytes-in']) + rnd(1e5, 5e6));
    a['bytes-out'] = String(Number(a['bytes-out']) + rnd(1e4, 5e5));
  }
  if (Math.random() < 0.15) {
    st.logs.push({ time: new Date().toTimeString().slice(0, 8), topics: 'system,info', message: pick(['config changed by api', 'dhcp-lan assigned 192.168.10.' + rnd(10, 60), 'hotspot user logged out']) });
    if (st.logs.length > 200) st.logs.shift();
  }
}

class Simulator {
  constructor(router) {
    this.host = router.host;
    this.connected = false;
    if (!states.has(this.host)) states.set(this.host, initState(router.name || router.host));
    this.st = states.get(this.host);
  }

  async connect() {
    await new Promise((r) => setTimeout(r, 30));
    if (/down\.sim$/i.test(this.host)) throw new Error(`Timed out connecting to ${this.host}`);
    this.connected = true;
  }

  async close() { this.connected = false; }

  log(message, topics = 'system,info') {
    this.st.logs.push({ time: new Date().toTimeString().slice(0, 8), topics, message });
  }

  crud(table, action, params, query) {
    switch (action) {
      case 'print': return Object.keys(query).length ? table.match(query) : table.rows.map((r) => ({ ...r }));
      case 'add': { const id = table.add(params); this.log(`item added by api: ${params.name || params.target || ''}`); return [{ ret: id }]; }
      case 'set': table.set(params['.id'], Object.fromEntries(Object.entries(params).filter(([k]) => k !== '.id'))); return [];
      case 'remove': table.remove(params['.id']); return [];
      case 'enable': for (const id of String(params['.id']).split(',')) table.set(id, { disabled: 'false' }); return [];
      case 'disable': for (const id of String(params['.id']).split(',')) table.set(id, { disabled: 'true' }); return [];
      default: throw new Error(`unknown command ${action}`);
    }
  }

  async exec(cmd, params = {}, query = {}) {
    if (!this.connected) await this.connect();
    const st = this.st;
    const parts = cmd.split('/').filter(Boolean);
    const action = parts.pop();
    const menu = '/' + parts.join('/');

    switch (menu) {
      case '/system/resource':
        tick(st);
        return [{
          'cpu-load': String(st.cpu), 'free-memory': String(Math.round(st.memTotal - st.memUsed)), 'total-memory': String(st.memTotal),
          uptime: fmtUptime(Math.floor((Date.now() - st.boot) / 1000)), version: '7.16.1 (stable)', 'board-name': 'RB4011iGS+', 'architecture-name': 'arm', 'cpu-count': '4',
          'free-hdd-space': '400000000', 'total-hdd-space': '512000000',
        }];
      case '/system/health':
        return [{ name: 'temperature', value: String(40 + rnd(0, 15)), type: 'C' }, { name: 'voltage', value: '24.1', type: 'V' }];
      case '/system/identity':
        return [{ name: st.name }];
      case '/interface':
        if (action === 'monitor-traffic') {
          const wanted = String(params.interface || '').split(',');
          return st.ifaces.filter((i) => wanted.includes(i.name)).map((i) => ({
            name: i.name, 'rx-bits-per-second': String(Math.round(i.running ? i.rx : 0)), 'tx-bits-per-second': String(Math.round(i.running ? i.tx : 0)),
          }));
        }
        return st.ifaces.map((i, n) => ({ '.id': '*' + (n + 1), name: i.name, type: i.type, running: String(i.running), disabled: 'false', 'mac-address': '4C:5E:0C:00:00:0' + n }));
      case '/ip/hotspot/active':
        return this.crud(st.hotspotActive, action, params, query);
      case '/ppp/active':
        return this.crud(st.pppActive, action, params, query);
      case '/ip/dhcp-server/lease':
        return this.crud(st.leases, action, params, query);
      case '/log':
        return st.logs.map((l, n) => ({ '.id': '*' + n, ...l }));
      case '/ip/hotspot':
        return this.crud(st.hsServers, action, params, query);
      case '/ip/hotspot/user/profile':
        return this.crud(st.hsProfiles, action, params, query);
      case '/ip/hotspot/user':
        if (action === 'reset-counters') {
          for (const id of String(params['.id']).split(',')) st.hsUsers.set(id, { uptime: '0s', 'bytes-in': '0', 'bytes-out': '0' });
          return [];
        }
        if (action === 'add' && st.hsUsers.match({ name: params.name }).length) throw new Error('failure: already have user with this name for this server');
        return this.crud(st.hsUsers, action, action === 'add' ? { uptime: '0s', 'bytes-in': '0', 'bytes-out': '0', ...params } : params, query);
      case '/queue/simple':
        if (action === 'print') {
          return st.queues.rows.map((q) => {
            const [up, down] = String(q['max-limit'] || '0/0').split('/').map(parseRate);
            const cap = (lim, base) => Math.round(Math.min(lim || Infinity, base * (0.3 + Math.random() * 0.7)));
            return { ...q, rate: q.disabled === 'true' ? '0/0' : `${cap(up, 3e6)}/${cap(down, 12e6)}` };
          });
        }
        if (action === 'add' && st.queues.match({ name: params.name }).length) throw new Error('failure: already have such name');
        if (action === 'add' && params.parent && params.parent !== 'none' && !st.queues.match({ name: params.parent }).length) throw new Error('input does not match any value of parent');
        if (action === 'remove') {
          const names = String(params['.id']).split(',').map((id) => (st.queues.find(id) || {}).name);
          if (st.queues.rows.some((q) => names.includes(q.parent))) throw new Error('failure: queue has children');
        }
        return this.crud(st.queues, action, params, query);
      default:
        throw new Error(`no such command prefix (${cmd})`);
    }
  }
}

module.exports = Simulator;
