/* Tab User Hotspot, Voucher, Profil Hotspot. */
(function () {
  const { api, esc, fmt, run, modal, confirmBox, formData, toast } = App;
  const { id, base, table, filterRows, loaders } = RT;
  const enc = encodeURIComponent;

  let users = [];
  let profiles = [];
  let servers = [];

  async function loadMeta() {
    [profiles, servers] = await Promise.all([api.get(`${base}/hotspot-profiles`), api.get(`${base}/hotspot-servers`)]);
    const pOpts = profiles.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p['rate-limit'] ? ' (' + esc(p['rate-limit']) + ')' : ''}</option>`).join('');
    const sOpts = '<option value="all">all (semua server)</option>' + servers.map((s) => `<option>${esc(s.name)}</option>`).join('');
    document.querySelectorAll('[data-profiles]').forEach((s) => { const v = s.value; s.innerHTML = pOpts; if (v) s.value = v; });
    document.querySelectorAll('[data-servers]').forEach((s) => { const v = s.value; s.innerHTML = sOpts; if (v) s.value = v; });
    const pf = document.getElementById('hsProfileFilter');
    const cur = pf.value;
    pf.innerHTML = '<option value="">Semua profil</option>' + profiles.map((p) => `<option>${esc(p.name)}</option>`).join('');
    pf.value = cur;
  }

  const limitText = (u) => {
    const parts = [];
    if (u['limit-uptime'] && u['limit-uptime'] !== '0s') parts.push('⏱ ' + u['limit-uptime']);
    if (u['limit-bytes-total'] && u['limit-bytes-total'] !== '0') parts.push('📦 ' + fmt.bytes(u['limit-bytes-total']));
    return parts.join(' · ') || '<span class="muted">–</span>';
  };

  /* ================= User Hotspot ================= */
  function renderUsers() {
    const q = document.getElementById('hsSearch').value;
    const pf = document.getElementById('hsProfileFilter').value;
    const sf = document.getElementById('hsStatusFilter').value;
    let rows = filterRows(users, q);
    if (pf) rows = rows.filter((u) => u.profile === pf);
    if (sf === 'online') rows = rows.filter((u) => u.online);
    if (sf === 'disabled') rows = rows.filter((u) => u.disabled === 'true');
    table('hsTable', [
      { h: 'Username', v: (u) => `<b>${esc(u.name)}</b>${u.online ? ' <span class="badge ok">online</span>' : ''}${u.disabled === 'true' ? ' <span class="badge">nonaktif</span>' : ''}` },
      { h: 'Password', v: (u) => `<span class="mono small" data-pw="${esc(u.password || '')}">••••••</span>` },
      { h: 'Profil', v: (u) => esc(u.profile || 'default') },
      { h: 'Batas', v: limitText },
      { h: 'Terpakai', v: (u) => `<span class="small nowrap">${esc(u.uptime || '0s')} · ${fmt.bytes(Number(u['bytes-in'] || 0) + Number(u['bytes-out'] || 0))}</span>` },
      { h: 'MAC', v: (u) => `<span class="mono small">${esc(u['mac-address'] && u['mac-address'] !== '00:00:00:00:00:00' ? u['mac-address'] : '')}</span>` },
      { h: 'Komentar', v: (u) => `<span class="small muted">${esc(u.comment || '')}</span>` },
      { h: '', cls: 'actions', v: (u) => `<button class="btn sm" data-act="edit">Edit</button>
        <button class="btn sm" data-act="toggle">${u.disabled === 'true' ? 'Aktifkan' : 'Nonaktifkan'}</button>
        <button class="btn sm" data-act="reset" title="Reset pemakaian">Reset</button>
        <button class="btn sm danger" data-act="del">Hapus</button>` },
    ], rows, {
      empty: users.length ? 'Tidak ada user yang cocok dengan filter' : 'Belum ada user hotspot',
      rowClass: (u) => (u.disabled === 'true' ? 'disabled' : ''),
      footer: `${rows.length} dari ${users.length} user · ${users.filter((u) => u.online).length} online`,
      actions: {
        edit: (u) => userForm(u),
        toggle: async (u) => { await run(() => api.post(`${base}/hotspot-users/${enc(u['.id'])}/${u.disabled === 'true' ? 'enable' : 'disable'}`, { label: u.name }), 'User diperbarui'); loadUsers(); },
        reset: async (u) => { await run(() => api.post(`${base}/hotspot-users/${enc(u['.id'])}/reset`, { label: u.name }), 'Pemakaian direset'); loadUsers(); },
        del: async (u) => {
          if (!(await confirmBox('Hapus user?', `User hotspot "${u.name}" akan dihapus dari router.`, 'Hapus'))) return;
          await run(() => api.del(`${base}/hotspot-users/${enc(u['.id'])}?label=${enc(u.name)}`), 'User dihapus');
          loadUsers();
        },
      },
    });
    document.querySelectorAll('#hsTable [data-pw]').forEach((s) => {
      s.style.cursor = 'pointer'; s.title = 'Klik untuk lihat';
      s.onclick = () => { s.textContent = s.textContent.startsWith('•') ? s.dataset.pw || '(kosong)' : '••••••'; };
    });
  }

  async function loadUsers() {
    users = await api.get(`${base}/hotspot-users`);
    renderUsers();
  }

  async function userForm(u) {
    if (!profiles.length) await loadMeta();
    const lu = u && u['limit-uptime'] !== '0s' ? u['limit-uptime'] || '' : '';
    const toInput = (n) => {
      n = Number(n);
      if (!n) return '';
      for (const [s, m] of [['T', 1024 ** 4], ['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]]) if (n % m === 0) return `${n / m}${s}`;
      return String(n);
    };
    const lb = u ? toInput(u['limit-bytes-total']) : '';
    const html = `<div class="form-grid">
      <div class="field"><label>Username</label><input name="name" required value="${esc(u ? u.name : '')}" autocomplete="off"></div>
      <div class="field"><label>Password</label><div class="btn-row" style="flex-wrap:nowrap"><input name="password" value="${esc(u ? u.password || '' : '')}" autocomplete="off"><button type="button" class="btn sm" data-gen>Acak</button></div></div>
      <div class="field"><label>Profil</label><select name="profile">${profiles.map((p) => `<option ${u && u.profile === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Server</label><select name="server"><option value="all">all</option>${servers.map((s) => `<option ${u && u.server === s.name ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Batas waktu <span class="hint">(30m, 3h, 1d)</span></label><input name="limitUptime" value="${esc(lu)}" placeholder="tanpa batas"></div>
      <div class="field"><label>Kuota <span class="hint">(500M, 2G)</span></label><input name="limitBytes" value="${esc(lb)}" placeholder="tanpa batas"></div>
      <div class="field"><label>Kunci ke MAC <span class="hint">opsional</span></label><input name="mac" value="${esc(u && u['mac-address'] !== '00:00:00:00:00:00' ? u['mac-address'] || '' : '')}" placeholder="AA:BB:CC:DD:EE:FF"></div>
      <div class="field"><label>Komentar</label><input name="comment" value="${esc(u ? u.comment || '' : '')}"></div>
    </div>`;
    const p = modal(u ? `Edit user ${u.name}` : 'Tambah User Hotspot', html, {
      onSubmit: (f) => (u ? api.put(`${base}/hotspot-users/${enc(u['.id'])}`, formData(f)) : api.post(`${base}/hotspot-users`, formData(f))),
    });
    const form = document.querySelector('.modal-backdrop:last-child form');
    form.querySelector('[data-gen]').onclick = () => {
      const c = 'abcdefghjkmnpqrstuvwxyz23456789';
      form.querySelector('[name=password]').value = Array.from(crypto.getRandomValues(new Uint32Array(8)), (n) => c[n % c.length]).join('');
    };
    if (await p) { toast(u ? 'User diperbarui' : 'User ditambahkan', 'ok'); loadUsers(); }
  }

  loaders.hsusers = async () => { await loadMeta(); await loadUsers(); };
  document.getElementById('hsAdd').onclick = () => userForm(null);
  document.getElementById('hsRefresh').onclick = () => loadUsers();
  ['hsSearch', 'hsProfileFilter', 'hsStatusFilter'].forEach((x) => { document.getElementById(x).oninput = renderUsers; });

  /* ================= Voucher ================= */
  let batches = [];
  async function loadBatches() {
    batches = await api.get(`${base}/hotspot-batches`);
    table('batches', [
      { h: 'Batch', v: (b) => `<span class="mono">${esc(b.batch)}</span>` },
      { h: 'Catatan', v: (b) => esc(b.note || '–') },
      { h: 'Profil', v: (b) => esc(b.profile) },
      { h: 'Jumlah', cls: 'num', v: (b) => b.count },
      { h: 'Terpakai', cls: 'num', v: (b) => `${b.used} <span class="muted small">(${Math.round((b.used / b.count) * 100)}%)</span>` },
      { h: '', cls: 'actions', v: () => '<button class="btn sm primary" data-act="print">Cetak</button> <button class="btn sm" data-act="csv">CSV</button> <button class="btn sm danger" data-act="del">Hapus batch</button>' },
    ], batches, {
      empty: 'Belum ada voucher yang dibuat dari aplikasi',
      actions: {
        print: (b) => openPrint(b.batch),
        csv: (b) => downloadCsv(b),
        del: async (b) => {
          if (!(await confirmBox('Hapus batch voucher?', `Semua ${b.count} user di batch ${b.batch} akan dihapus dari router.`, 'Hapus semua'))) return;
          const r = await run(() => api.del(`${base}/hotspot-batches/${enc(b.batch)}`));
          toast(`${r.removed} voucher dihapus`, 'ok');
          loadBatches();
        },
      },
    });
  }
  let lastPrice = '';
  function openPrint(batch) {
    window.open(`/voucher-print.html?id=${id}&batch=${enc(batch)}&price=${enc(lastPrice)}`, '_blank');
  }
  function downloadCsv(b) {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const csv = ['username,password,profil,batas_waktu,kuota_bytes', ...b.users.map((u) => [u.name, u.password, u.profile, u['limit-uptime'], u['limit-bytes-total']].map(q).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `voucher-${b.batch}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  loaders.voucher = async () => { await loadMeta(); await loadBatches(); };
  document.getElementById('batchRefresh').onclick = () => loadBatches();
  document.getElementById('genForm').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    lastPrice = d.price || '';
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await run(() => api.post(`${base}/hotspot-users/generate`, { ...d, count: Number(d.count), length: Number(d.length) }));
      toast(`${r.users.length} voucher dibuat${r.errors.length ? ` (${r.errors.length} gagal: ${r.errors[0]})` : ''}`, r.errors.length ? 'warn' : 'ok', 6000);
      await loadBatches();
      if (r.users.length) openPrint(r.batch);
    } finally { btn.disabled = false; }
  };

  /* ================= Profil Hotspot ================= */
  async function loadProfiles() {
    profiles = await api.get(`${base}/hotspot-profiles`);
    table('profTable', [
      { h: 'Nama', v: (p) => `<b>${esc(p.name)}</b>` },
      { h: 'Rate limit', v: (p) => esc(p['rate-limit'] ? fmt.rate(p['rate-limit']) : 'tanpa batas') },
      { h: 'Device per akun', v: (p) => esc(p['shared-users'] || '1') },
      { h: 'Session timeout', v: (p) => esc(p['session-timeout'] && p['session-timeout'] !== '0s' ? p['session-timeout'] : '–') },
      { h: 'Jumlah user', cls: 'num', v: (p) => users.filter((u) => (u.profile || 'default') === p.name).length || (users.length ? 0 : '–') },
      { h: '', cls: 'actions', v: (p) => `<button class="btn sm" data-act="edit">Edit</button>${p.name !== 'default' ? ' <button class="btn sm danger" data-act="del">Hapus</button>' : ''}` },
    ], profiles, {
      empty: 'Tidak ada profil',
      actions: {
        edit: (p) => profileForm(p),
        del: async (p) => {
          if (!(await confirmBox('Hapus profil?', `Profil "${p.name}" akan dihapus dari router.`, 'Hapus'))) return;
          await run(() => api.del(`${base}/hotspot-profiles/${enc(p['.id'])}?label=${enc(p.name)}`), 'Profil dihapus');
          loadProfiles();
        },
      },
    });
  }
  async function profileForm(p) {
    const ok = await modal(p ? `Edit profil ${p.name}` : 'Profil Hotspot Baru', `<div class="form-grid">
      <div class="field"><label>Nama</label><input name="name" required value="${esc(p ? p.name : '')}" ${p && p.name === 'default' ? 'readonly' : ''} placeholder="harian-5M"></div>
      <div class="field"><label>Rate limit <span class="hint">(up/down)</span></label><input name="rateLimit" value="${esc(p ? p['rate-limit'] || '' : '')}" placeholder="2M/5M"></div>
      <div class="field"><label>Device per akun</label><input name="sharedUsers" type="number" min="1" value="${esc(p ? p['shared-users'] || 1 : 1)}"></div>
      <div class="field"><label>Session timeout <span class="hint">(mis. 1h)</span></label><input name="sessionTimeout" value="${esc(p && p['session-timeout'] !== '0s' ? p['session-timeout'] || '' : '')}" placeholder="tanpa batas"></div>
    </div>`, {
      onSubmit: (f) => (p ? api.put(`${base}/hotspot-profiles/${enc(p['.id'])}`, formData(f)) : api.post(`${base}/hotspot-profiles`, formData(f))),
    });
    if (ok) { toast('Profil disimpan', 'ok'); loadProfiles(); }
  }
  loaders.hsprofiles = async () => {
    if (!users.length) users = await api.get(`${base}/hotspot-users`).catch(() => []);
    await loadProfiles();
  };
  document.getElementById('profAdd').onclick = () => profileForm(null);
})();
