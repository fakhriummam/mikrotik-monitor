const { RouterOSAPI } = require('node-routeros');
const config = require('../config');
const Simulator = require('./simulator');

/**
 * Wrapper tipis di atas node-routeros.
 * exec(cmd, params, query) -> array of objects (nilai string, seperti API RouterOS).
 *   params: { key: value }  -> "=key=value"
 *   query:  { key: value }  -> "?key=value"
 */
class RosClient {
  constructor({ host, port, username, password, useSsl }) {
    this.opts = { host, port: Number(port) || (useSsl ? 8729 : 8728), username, password, useSsl: !!useSsl };
    this.api = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    const api = new RouterOSAPI({
      host: this.opts.host,
      port: this.opts.port,
      user: this.opts.username,
      password: this.opts.password,
      timeout: 10,
      keepalive: true,
      tls: this.opts.useSsl ? { rejectUnauthorized: false } : undefined,
    });
    // tanpa handler, error socket akan membuat proses crash
    api.on('error', () => { this.connected = false; });
    api.on('close', () => { this.connected = false; });
    await api.connect();
    this.api = api;
    this.connected = true;
  }

  async exec(cmd, params = {}, query = {}) {
    if (!this.connected) await this.connect();
    const words = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      words.push(`=${k}=${v}`);
    }
    for (const [k, v] of Object.entries(query)) words.push(`?${k}=${v}`);
    try {
      const res = await this.api.write(cmd, words);
      return Array.isArray(res) ? res : [];
    } catch (err) {
      // !empty bukan error sebenarnya
      if (err && err.errno === 'UNKNOWNREPLY' && /!empty/.test(String(err.message))) return [];
      if (err && /closed|timeout|ECONN|socket/i.test(String(err.message || err.errno))) this.connected = false;
      throw err;
    }
  }

  async close() {
    this.connected = false;
    if (this.api) {
      try { await this.api.close(); } catch { /* abaikan */ }
    }
    this.api = null;
  }
}

function isSimulated(host) {
  return config.simulate || host === 'simulator' || /\.sim$/i.test(host);
}

function createClient(router) {
  return isSimulated(router.host) ? new Simulator(router) : new RosClient(router);
}

module.exports = { createClient, isSimulated };
