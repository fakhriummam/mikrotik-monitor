/**
 * Manajemen bandwidth berbasis Simple Queue + Profil "Mode Event".
 *
 * Jenis aturan (rule):
 *  - { type: 'limit',  name, target, maxLimit, limitAt?, priority? }   -> tambah queue baru (limit subnet / device)
 *  - { type: 'focus',  name, device, network, total, guarantee }      -> prioritaskan 1 device:
 *        <name>-induk   target=network  max-limit=total
 *          ├─ <name>-device   target=device   limit-at=guarantee  priority=1
 *          └─ <name>-lainnya  target=network  priority=8
 *  - { type: 'modify', queue, maxLimit }                               -> ubah max-limit queue yang sudah ada
 *  - { type: 'disable', queue }                                        -> nonaktifkan queue yang sudah ada
 *  - { type: 'hotspotProfile', profile, rateLimit }                    -> ubah rate-limit profil user hotspot
 * Queue buatan aplikasi diberi comment "mtmon:<tag>" agar mudah dikenali & dibersihkan.
 */
const { db, audit } = require('./db');
const poller = require('./poller');
const alerts = require('./alerts');

const SINGLE_RATE = /^\d+(\.\d+)?[kKmMgG]?$/;
const TARGET_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

function normRate(v, field) {
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!s) return undefined;
  if (SINGLE_RATE.test(s)) return `${s}/${s}`; // "10M" -> "10M/10M"
  const [a, b, extra] = s.split('/');
  if (extra !== undefined || !SINGLE_RATE.test(a || '') || !SINGLE_RATE.test(b || '')) {
    throw badRequest(`${field} tidak valid: "${v}" (format upload/download, contoh: 5M/20M)`);
  }
  return s;
}
function normTarget(v, field = 'Target') {
  const parts = String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw badRequest(`${field} wajib diisi`);
  for (const p of parts) {
    if (!TARGET_RE.test(p) || p.split('/')[0].split('.').some((o) => Number(o) > 255)) {
      throw badRequest(`${field} tidak valid: "${p}" (contoh: 192.168.10.0/24 atau 192.168.10.5)`);
    }
  }
  return parts.map((p) => (p.includes('/') ? p : `${p}/32`)).join(',');
}
function normName(v) {
  const s = String(v || '').trim();
  if (!/^[\w.\-]{1,40}$/.test(s)) throw badRequest('Nama queue wajib diisi (huruf, angka, - _ . tanpa spasi, maks 40)');
  return s;
}
function normPriority(v) {
  const p = Number(String(v || 8).split('/')[0]); // terima "3" atau "3/3"
  if (!(Number.isInteger(p) && p >= 1 && p <= 8)) throw badRequest('Priority harus 1–8');
  return `${p}/${p}`;
}
function required(v, msg) {
  const s = String(v || '').trim();
  if (!s) throw badRequest(msg);
  return s;
}

function validateRule(rule = {}) {
  switch (rule.type) {
    case 'limit':
      return {
        type: 'limit', name: normName(rule.name), target: normTarget(rule.target),
        maxLimit: normRate(rule.maxLimit, 'Max limit') || '0/0',
        limitAt: normRate(rule.limitAt, 'Limit-at') || '0/0',
        priority: normPriority(rule.priority),
      };
    case 'focus': {
      const total = normRate(rule.total, 'Total bandwidth');
      const guarantee = normRate(rule.guarantee, 'Bandwidth terjamin');
      if (!total || !guarantee) throw badRequest('Total bandwidth dan bandwidth terjamin wajib diisi');
      const device = normTarget(rule.device, 'IP device');
      return { type: 'focus', name: normName(rule.name || `fokus-${device.split('/')[0]}`), device, network: normTarget(rule.network, 'Network'), total, guarantee };
    }
    case 'modify':
      return { type: 'modify', queue: required(rule.queue, 'Pilih queue yang diubah'), maxLimit: normRate(rule.maxLimit, 'Max limit') || '0/0' };
    case 'disable':
      return { type: 'disable', queue: required(rule.queue, 'Pilih queue yang dinonaktifkan') };
    case 'hotspotProfile':
      return { type: 'hotspotProfile', profile: required(rule.profile, 'Pilih profil hotspot'), rateLimit: normRate(rule.rateLimit, 'Rate limit') || '' };
    default:
      throw badRequest(`Jenis aturan tidak dikenal: ${rule.type}`);
  }
}

function describeRule(r) {
  switch (r.type) {
    case 'limit': return `Limit ${r.target} → ${r.maxLimit}`;
    case 'focus': return `Fokus device ${r.device} (terjamin ${r.guarantee} dari ${r.total})`;
    case 'modify': return `Ubah queue "${r.queue}" → ${r.maxLimit}`;
    case 'disable': return `Nonaktifkan queue "${r.queue}"`;
    case 'hotspotProfile': return `Profil hotspot "${r.profile}" rate-limit → ${r.rateLimit || 'tanpa batas'}`;
    default: return r.type;
  }
}

/**
 * Terapkan daftar aturan ke router.
 * Return { created: [queue .id], snapshot: [{kind, id, props}] } untuk kembalikan normal.
 * Jika gagal di tengah jalan, semua perubahan yang sudah terjadi dibatalkan.
 */
async function applyRules(w, rawRules, tag) {
  const rules = rawRules.map(validateRule);
  const created = [];
  const snapshot = [];
  const comment = `mtmon:${tag}`;
  try {
    const queues = await w.exec('/queue/simple/print');
    const byName = new Map(queues.map((q) => [q.name, q]));
    const topId = queues.length ? queues[0]['.id'] : undefined;

    const add = async (props, top) => {
      const params = { ...props, comment };
      if (top && topId) params['place-before'] = topId;
      const r = await w.exec('/queue/simple/add', params);
      let id = r[0] && (r[0].ret || r[0]['.id']);
      if (!id) {
        const found = await w.exec('/queue/simple/print', {}, { name: props.name });
        id = found[0] && found[0]['.id'];
      }
      if (id) created.push(id);
    };

    // focus diproses dulu dan ditaruh paling atas, agar trafik device tertangkap sebelum queue lain
    for (const r of rules.filter((x) => x.type === 'focus')) {
      await add({ name: `${r.name}-induk`, target: r.network, 'max-limit': r.total }, true);
      await add({ name: `${r.name}-device`, target: r.device, parent: `${r.name}-induk`, 'limit-at': r.guarantee, 'max-limit': r.total, priority: '1/1' }, true);
      await add({ name: `${r.name}-lainnya`, target: r.network, parent: `${r.name}-induk`, 'max-limit': r.total, priority: '8/8' }, true);
    }
    for (const r of rules.filter((x) => x.type !== 'focus')) {
      if (r.type === 'limit') {
        await add({ name: r.name, target: r.target, 'max-limit': r.maxLimit, 'limit-at': r.limitAt, priority: r.priority }, false);
      } else if (r.type === 'modify' || r.type === 'disable') {
        const q = byName.get(r.queue);
        if (!q) throw badRequest(`Queue "${r.queue}" tidak ditemukan di router`);
        snapshot.push({ kind: 'queue', id: q['.id'], name: q.name, props: { 'max-limit': q['max-limit'], disabled: q.disabled } });
        if (r.type === 'modify') await w.exec('/queue/simple/set', { '.id': q['.id'], 'max-limit': r.maxLimit });
        else await w.exec('/queue/simple/disable', { '.id': q['.id'] });
      } else if (r.type === 'hotspotProfile') {
        const [p] = await w.exec('/ip/hotspot/user/profile/print', {}, { name: r.profile });
        if (!p) throw badRequest(`Profil hotspot "${r.profile}" tidak ditemukan`);
        snapshot.push({ kind: 'hotspotProfile', id: p['.id'], name: p.name, props: { 'rate-limit': p['rate-limit'] || '' } });
        await w.exec('/ip/hotspot/user/profile/set', { '.id': p['.id'], 'rate-limit': r.rateLimit });
      }
    }
    return { created, snapshot };
  } catch (err) {
    await revertChanges(w, created, snapshot).catch(() => {});
    throw err;
  }
}

async function revertChanges(w, created, snapshot) {
  const errors = [];
  // hapus child dulu (urutan terbalik)
  for (const id of [...created].reverse()) {
    try { await w.exec('/queue/simple/remove', { '.id': id }); } catch (e) { if (!/no such item/i.test(e.message)) errors.push(e.message); }
  }
  for (const s of [...snapshot].reverse()) {
    try {
      if (s.kind === 'queue') {
        await w.exec('/queue/simple/set', { '.id': s.id, 'max-limit': s.props['max-limit'] || '0/0' });
        await w.exec(s.props.disabled === 'true' ? '/queue/simple/disable' : '/queue/simple/enable', { '.id': s.id });
      } else if (s.kind === 'hotspotProfile') {
        await w.exec('/ip/hotspot/user/profile/set', { '.id': s.id, 'rate-limit': s.props['rate-limit'] });
      }
    } catch (e) { errors.push(`${s.name}: ${e.message}`); }
  }
  if (errors.length) throw new Error('Sebagian gagal dikembalikan: ' + errors.join('; '));
}

/* ---------- Profil & aktivasi Mode Event ---------- */

function getProfile(id) {
  const p = db.prepare('SELECT * FROM bw_profiles WHERE id = ?').get(id);
  if (!p) { const e = new Error('Profil tidak ditemukan'); e.status = 404; throw e; }
  return { ...p, rules: JSON.parse(p.rules_json) };
}

function currentActivation(routerId) {
  return db.prepare("SELECT a.*, p.name AS profile_name FROM bw_activations a JOIN bw_profiles p ON p.id = a.profile_id WHERE a.router_id = ? AND a.status IN ('active','scheduled') ORDER BY a.id DESC").all(routerId);
}

async function activate(profileId, { durationMin, startAt, user } = {}) {
  const p = getProfile(profileId);
  if (db.prepare("SELECT 1 FROM bw_activations WHERE router_id = ? AND status = 'active'").get(p.router_id)) {
    throw badRequest('Masih ada Mode Event yang aktif di router ini. Kembalikan normal dulu.');
  }
  p.rules.forEach(validateRule);
  const now = Date.now();
  const starts = startAt ? Number(new Date(startAt)) : now;
  if (!Number.isFinite(starts)) throw badRequest('Waktu mulai tidak valid');
  const ends = durationMin ? starts + Number(durationMin) * 60000 : null;
  if (ends !== null && !(ends > now)) throw badRequest('Durasi/waktu selesai sudah lewat');
  const info = db.prepare("INSERT INTO bw_activations(profile_id, router_id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, 'scheduled')")
    .run(p.id, p.router_id, starts, ends);
  audit(user, p.router_id, starts > now + 1000 ? 'event.schedule' : 'event.activate', { profile: p.name, starts, ends });
  if (starts <= now + 1000) await runActivation(info.lastInsertRowid);
  return db.prepare('SELECT * FROM bw_activations WHERE id = ?').get(info.lastInsertRowid);
}

async function runActivation(actId) {
  const a = db.prepare('SELECT * FROM bw_activations WHERE id = ?').get(actId);
  const p = getProfile(a.profile_id);
  const w = poller.getWorker(a.router_id);
  try {
    const { created, snapshot } = await applyRules(w, p.rules, `event:${a.id}`);
    db.prepare("UPDATE bw_activations SET status = 'active', starts_at = ?, created_ids = ?, snapshot_json = ? WHERE id = ?")
      .run(Date.now(), JSON.stringify(created), JSON.stringify(snapshot), a.id);
    const until = a.ends_at ? ` sampai ${new Date(a.ends_at).toLocaleString('id-ID')}` : '';
    alerts.raise(w.router, 'event_on', `Mode Event "${p.name}" AKTIF${until}\n` + p.rules.map((r) => '• ' + describeRule(validateRule(r))).join('\n'));
  } catch (err) {
    db.prepare("UPDATE bw_activations SET status = 'failed' WHERE id = ?").run(a.id);
    throw err;
  }
}

async function revert(actId, { user, auto } = {}) {
  const a = db.prepare('SELECT * FROM bw_activations WHERE id = ?').get(actId);
  if (!a) { const e = new Error('Aktivasi tidak ditemukan'); e.status = 404; throw e; }
  const p = getProfile(a.profile_id);
  if (a.status === 'scheduled') {
    db.prepare("UPDATE bw_activations SET status = 'cancelled' WHERE id = ?").run(a.id);
    audit(user, a.router_id, 'event.cancel', { profile: p.name });
    return;
  }
  if (a.status !== 'active') throw badRequest('Mode Event ini tidak sedang aktif');
  const w = poller.getWorker(a.router_id);
  await revertChanges(w, JSON.parse(a.created_ids || '[]'), JSON.parse(a.snapshot_json || '[]'));
  db.prepare("UPDATE bw_activations SET status = 'reverted', ends_at = ? WHERE id = ?").run(Date.now(), a.id);
  audit(user || 'system', a.router_id, 'event.revert', { profile: p.name, auto: !!auto });
  alerts.raise(w.router, 'event_off', `Mode Event "${p.name}" selesai — bandwidth dikembalikan normal${auto ? ' (otomatis)' : ''}`);
}

let schedulerBusy = false;
async function schedulerTick() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const now = Date.now();
    for (const a of db.prepare("SELECT id FROM bw_activations WHERE status = 'scheduled' AND starts_at <= ?").all(now)) {
      await runActivation(a.id).catch((e) => console.warn('[event] gagal aktivasi', a.id, e.message));
    }
    for (const a of db.prepare("SELECT id FROM bw_activations WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ?").all(now)) {
      await revert(a.id, { auto: true }).catch((e) => console.warn('[event] gagal revert', a.id, e.message));
    }
  } finally {
    schedulerBusy = false;
  }
}

function startScheduler() {
  setInterval(schedulerTick, 15000);
  setTimeout(schedulerTick, 3000);
}

module.exports = { validateRule, describeRule, applyRules, revertChanges, activate, revert, currentActivation, getProfile, startScheduler, schedulerTick, normRate, normTarget };
