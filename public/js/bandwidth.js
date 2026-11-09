/* Tab Bandwidth (Simple Queue, fokus device) & Mode Event. */
(function () {
  const { api, esc, fmt, run, modal, confirmBox, formData, toast } = App;
  const { base, table, loaders, leaveHandlers, pickDevice } = RT;

  /* ================= Bandwidth ================= */
  let queues = [];
  let qTimer = null;

  const parseRate = (s) => String(s || '0/0').split('/').map(Number);
  function originBadge(q) {
    const c = String(q.comment || '');
    if (c.startsWith('mtmon:event:')) return '<span class="badge warn">event</span>';
    if (c.startsWith('mtmon:focus:')) return '<span class="badge info">fokus</span>';
    if (c.startsWith('mtmon:')) return '<span class="badge info">aplikasi</span>';
    return '';
  }

  function renderQueues() {
    table('queueTable', [
      { h: 'Nama', v: (q) => `<b>${esc(q.name)}</b> ${originBadge(q)}${q.comment && !q.managed ? `<div class="small muted">${esc(q.comment)}</div>` : ''}` },
      { h: 'Target', v: (q) => `<span class="mono">${esc(q.target)}</span>` },
      { h: 'Parent', v: (q) => esc(q.parent && q.parent !== 'none' ? q.parent : '–') },
      { h: 'Max limit', v: (q) => `<span class="nowrap">${esc(fmt.rate(q['max-limit']))}</span>` },
      { h: 'Terjamin', v: (q) => `<span class="nowrap">${esc(q['limit-at'] && q['limit-at'] !== '0/0' ? fmt.rate(q['limit-at']) : '–')}</span>` },
      { h: 'Prio', v: (q) => esc(String(q.priority || '8/8').split('/')[0]) },
      { h: 'Rate sekarang', v: (q) => { const [u, d] = parseRate(q.rate); return `<span class="nowrap small">↑${fmt.bps(u)} ↓${fmt.bps(d)}</span>`; } },
      { h: 'Status', v: (q) => (q.disabled === 'true' ? '<span class="badge">nonaktif</span>' : '<span class="badge ok">aktif</span>') },
      { h: '', cls: 'actions', v: (q) => {
        const c = String(q.comment || '');
        if (c.startsWith('mtmon:event:')) return '<span class="small muted">dikelola Mode Event</span>';
        if (c.startsWith('mtmon:focus:')) return q.name.endsWith('-induk') ? '<button class="btn sm danger" data-act="unfocus">Hapus fokus</button>' : '';
        return `<button class="btn sm" data-act="edit">Edit</button>
          <button class="btn sm" data-act="toggle">${q.disabled === 'true' ? 'Aktifkan' : 'Nonaktifkan'}</button>
          <button class="btn sm danger" data-act="del">Hapus</button>`;
      } },
    ], queues, {
      empty: 'Belum ada Simple Queue di router ini',
      rowClass: (q) => (q.disabled === 'true' ? 'disabled' : ''),
      actions: {
        edit: editQueue,
        toggle: async (q) => {
          await run(() => api.post(`${base}/queues/${encodeURIComponent(q['.id'])}/${q.disabled === 'true' ? 'enable' : 'disable'}`, { label: q.name }), 'Queue diperbarui');
          loadQueues();
        },
        del: async (q) => {
          if (!(await confirmBox('Hapus queue?', `Queue "${q.name}" akan dihapus dari router.`, 'Hapus'))) return;
          await run(() => api.del(`${base}/queues/${encodeURIComponent(q['.id'])}?label=${encodeURIComponent(q.name)}`), 'Queue dihapus');
          loadQueues();
        },
        unfocus: async (q) => {
          const name = String(q.comment).slice('mtmon:focus:'.length);
          if (!(await confirmBox('Hapus fokus device?', `Grup queue fokus "${name}" (induk + 2 child) akan dihapus.`, 'Hapus'))) return;
          await run(() => api.del(`${base}/queues/focus/${encodeURIComponent(name)}`), 'Fokus dihapus');
          loadQueues();
        },
      },
    });
  }

  async function loadQueues() {
    queues = await api.get(`${base}/queues`);
    renderQueues();
  }

  async function editQueue(q) {
    const ok = await modal(`Edit queue ${q.name}`, `
      <div class="form-grid">
        <div class="field full"><label>Target</label><input name="target" value="${esc(q.target)}"></div>
        <div class="field"><label>Max limit (up/down)</label><input name="maxLimit" value="${esc(q['max-limit'])}"></div>
        <div class="field"><label>Terjamin (limit-at)</label><input name="limitAt" value="${esc(q['limit-at'] || '0/0')}"></div>
        <div class="field"><label>Priority</label><input name="priority" type="number" min="1" max="8" value="${esc(String(q.priority || '8/8').split('/')[0])}"></div>
      </div><p class="small muted">Format: <span class="mono">upload/download</span>, contoh <span class="mono">5M/20M</span>. <span class="mono">0</span> = tanpa batas.</p>`, {
      onSubmit: (f) => api.put(`${base}/queues/${encodeURIComponent(q['.id'])}`, { ...formData(f), label: q.name }),
    });
    if (ok) { toast('Queue diperbarui', 'ok'); loadQueues(); }
  }

  loaders.bandwidth = async () => {
    await loadQueues();
    clearInterval(qTimer);
    qTimer = setInterval(() => loadQueues().catch(() => {}), 5000);
  };
  leaveHandlers.bandwidth = () => clearInterval(qTimer);
  document.getElementById('qRefresh').onclick = () => loadQueues();

  const guessNetwork = (ip) => { const p = String(ip).split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : ''; };

  document.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = async () => {
      const d = await pickDevice();
      if (!d) return;
      const form = b.closest('form');
      form.querySelector(`[name="${b.dataset.pick}"]`).value = d.ip;
      const slug = String(d.label || d.ip).replace(/[^\w.-]+/g, '-').slice(0, 24);
      if (form.id === 'limitForm' && !form.querySelector('[name=name]').value) form.querySelector('[name=name]').value = `limit-${slug}`;
      if (form.id === 'focusForm') {
        if (!form.network.value) form.network.value = guessNetwork(d.ip);
        if (!form.querySelector('[name=name]').value) form.querySelector('[name=name]').value = `fokus-${slug}`;
      }
    };
  });

  document.getElementById('limitForm').onsubmit = async (e) => {
    e.preventDefault();
    await run(() => api.post(`${base}/queues`, formData(e.target)), 'Bandwidth diterapkan');
    e.target.reset();
    loadQueues();
  };
  document.getElementById('focusForm').onsubmit = async (e) => {
    e.preventDefault();
    await run(() => api.post(`${base}/queues/focus`, formData(e.target)), 'Device difokuskan');
    e.target.reset();
    loadQueues();
  };
  document.querySelector('#focusForm [name=device]').addEventListener('change', (e) => {
    const n = e.target.form.network;
    if (!n.value) n.value = guessNetwork(e.target.value);
  });

  /* ================= Mode Event ================= */
  let profiles = [];
  let events = [];

  const RULE_TYPES = {
    limit: { label: 'Batasi subnet / device', fields: [['name', 'Nama queue', 'ev-aula'], ['target', 'Target', '10.0.5.0/24'], ['maxLimit', 'Max limit', '20M/50M'], ['priority', 'Priority', '8']] },
    focus: { label: 'Fokuskan device', fields: [['name', 'Nama', 'fokus-operator'], ['device', 'IP device', '192.168.10.15'], ['network', 'Network', '192.168.10.0/24'], ['total', 'Total', '50M'], ['guarantee', 'Terjamin', '20M']] },
    modify: { label: 'Ubah queue yang ada', fields: [['queue', 'Nama queue', ''], ['maxLimit', 'Max limit baru', '2M/5M']] },
    disable: { label: 'Nonaktifkan queue', fields: [['queue', 'Nama queue', '']] },
    hotspotProfile: { label: 'Ubah rate profil hotspot', fields: [['profile', 'Profil hotspot', ''], ['rateLimit', 'Rate limit baru', '1M/2M']] },
  };

  async function refreshEvent() {
    events = await api.get(`${base}/events`);
    const banner = document.getElementById('eventBanner');
    const act = events.filter((a) => a.status === 'active' || a.status === 'scheduled');
    banner.classList.toggle('hidden', !act.length);
    banner.innerHTML = act.map((a) => `<span>🎉 <b>Mode Event "${esc(a.profile_name)}"</b> ${a.status === 'active' ? 'sedang AKTIF' : 'terjadwal mulai ' + fmt.time(a.starts_at)}${a.ends_at ? ` · berakhir ${fmt.time(a.ends_at)}` : ' · tanpa batas waktu'}</span>
      <span class="spacer"></span><button class="btn sm ${a.status === 'active' ? 'primary' : ''}" data-revert="${a.id}">${a.status === 'active' ? 'Kembalikan normal' : 'Batalkan jadwal'}</button>`).join('<br>');
    banner.querySelectorAll('[data-revert]').forEach((b) => { b.onclick = () => revertEvent(Number(b.dataset.revert)); });
    renderHistory();
    renderProfiles();
  }
  RT.refreshEvent = refreshEvent;

  async function revertEvent(aid) {
    const a = events.find((x) => x.id === aid);
    if (!(await confirmBox(a && a.status === 'scheduled' ? 'Batalkan jadwal?' : 'Kembalikan bandwidth normal?', 'Semua perubahan dari Mode Event ini akan dikembalikan seperti semula.', 'Ya'))) return;
    await run(() => api.post(`${base}/events/${aid}/revert`), 'Bandwidth dikembalikan normal');
    refreshEvent();
    if (!document.querySelector('[data-panel="bandwidth"]').classList.contains('hidden')) loadQueues();
  }

  function renderProfiles() {
    const box = document.getElementById('profiles');
    if (!box) return;
    const activeIds = new Set(events.filter((a) => a.status === 'active' || a.status === 'scheduled').map((a) => a.profile_id));
    box.innerHTML = profiles.length ? profiles.map((p) => `<div class="card" data-pid="${p.id}">
        <div class="card-head"><h3>${esc(p.name)}</h3>${activeIds.has(p.id) ? '<span class="badge warn">aktif/terjadwal</span>' : ''}</div>
        <ul>${p.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
        <div class="btn-row">
          <button class="btn sm primary" data-a="activate" ${activeIds.size ? 'disabled' : ''}>Aktifkan</button>
          <button class="btn sm" data-a="edit" ${activeIds.has(p.id) ? 'disabled' : ''}>Edit</button>
          <button class="btn sm danger" data-a="del" ${activeIds.has(p.id) ? 'disabled' : ''}>Hapus</button>
        </div></div>`).join('')
      : '<div class="card empty" style="grid-column:1/-1">Belum ada profil. Buat profil, misalnya <b>"Event Seminar"</b>: aula 50M, laptop operator streaming diprioritaskan, Wi-Fi tamu dibatasi.</div>';
    box.querySelectorAll('[data-a]').forEach((b) => {
      const p = profiles.find((x) => x.id === Number(b.closest('[data-pid]').dataset.pid));
      b.onclick = () => ({ activate: activateProfile, edit: editProfile, del: deleteProfile }[b.dataset.a](p));
    });
  }

  function renderHistory() {
    const label = { active: ['warn', 'aktif'], scheduled: ['info', 'terjadwal'], reverted: ['ok', 'selesai'], failed: ['danger', 'gagal'], cancelled: ['', 'dibatalkan'] };
    table('eventHistory', [
      { h: 'Profil', v: (a) => esc(a.profile_name) },
      { h: 'Mulai', v: (a) => fmt.time(a.starts_at) },
      { h: 'Selesai', v: (a) => (a.ends_at ? fmt.time(a.ends_at) : '–') },
      { h: 'Status', v: (a) => { const [c, t] = label[a.status] || ['', a.status]; return `<span class="badge ${c}">${t}</span>`; } },
    ], events, { empty: 'Belum pernah diaktifkan' });
  }

  loaders.event = async () => {
    profiles = await api.get(`${base}/bw-profiles`);
    await refreshEvent();
  };

  function ruleRow(rule = { type: 'limit' }) {
    const t = RULE_TYPES[rule.type] || RULE_TYPES.limit;
    const val = (k) => {
      let v = rule[k] ?? '';
      if (k === 'priority' && v) v = String(v).split('/')[0];
      return esc(v);
    };
    return `<div class="rule">
      <div class="field"><label>Jenis</label><select data-type>${Object.entries(RULE_TYPES).map(([k, d]) => `<option value="${k}" ${k === rule.type ? 'selected' : ''}>${d.label}</option>`).join('')}</select></div>
      <div class="fields">${t.fields.map(([k, l, ph]) => `<div class="field"><label>${l}</label><input data-k="${k}" value="${val(k)}" placeholder="${esc(ph)}" ${k === 'queue' || k === 'profile' ? `list="dl-${k}"` : ''}></div>`).join('')}</div>
      <button type="button" class="btn sm danger" data-rm title="Hapus aturan">✕</button></div>`;
  }

  async function profileForm(p) {
    const [qs, hp] = await Promise.all([api.get(`${base}/queues`).catch(() => []), api.get(`${base}/hotspot-profiles`).catch(() => [])]);
    const html = `
      <div class="field" style="margin-bottom:12px"><label>Nama profil</label><input name="name" required value="${esc(p ? p.name : '')}" placeholder="Event Seminar"></div>
      <label>Aturan</label><div data-rules>${(p ? p.rules : [{ type: 'limit' }]).map(ruleRow).join('')}</div>
      <button type="button" class="btn sm" data-addrule>+ Tambah aturan</button>
      <datalist id="dl-queue">${qs.filter((q) => !q.managed).map((q) => `<option value="${esc(q.name)}">`).join('')}</datalist>
      <datalist id="dl-profile">${hp.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
      <p class="small muted">Format bandwidth <span class="mono">upload/download</span> (mis. <span class="mono">5M/20M</span>) atau satu angka untuk keduanya (<span class="mono">50M</span>).</p>`;
    const done = modal(p ? `Edit profil ${p.name}` : 'Profil Mode Event Baru', html, {
      wide: true,
      onSubmit: async (f) => {
        const rules = [...f.querySelectorAll('.rule')].map((el) => {
          const r = { type: el.querySelector('[data-type]').value };
          el.querySelectorAll('[data-k]').forEach((i) => { r[i.dataset.k] = i.value.trim(); });
          return r;
        });
        const body = { name: f.querySelector('[name=name]').value, rules };
        return p ? api.put(`${base}/bw-profiles/${p.id}`, body) : api.post(`${base}/bw-profiles`, body);
      },
    });
    const form = document.querySelector('.modal-backdrop:last-child form');
    const rulesBox = form.querySelector('[data-rules]');
    const wire = () => {
      rulesBox.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => b.closest('.rule').remove(); });
      rulesBox.querySelectorAll('[data-type]').forEach((s) => {
        s.onchange = () => { const div = document.createElement('div'); div.innerHTML = ruleRow({ type: s.value }); s.closest('.rule').replaceWith(div.firstElementChild); wire(); };
      });
    };
    wire();
    form.querySelector('[data-addrule]').onclick = () => { rulesBox.insertAdjacentHTML('beforeend', ruleRow()); wire(); };
    if (await done) { toast('Profil disimpan', 'ok'); loaders.event(); }
  }
  const editProfile = (p) => profileForm(p);
  document.getElementById('newProfile').onclick = () => profileForm(null);

  async function deleteProfile(p) {
    if (!(await confirmBox('Hapus profil?', `Profil "${p.name}" akan dihapus (tidak mengubah router).`, 'Hapus'))) return;
    await run(() => api.del(`${base}/bw-profiles/${p.id}`), 'Profil dihapus');
    loaders.event();
  }

  async function activateProfile(p) {
    const ok = await modal(`Aktifkan "${p.name}"`, `
      <ul>${p.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <div class="form-grid">
        <div class="field"><label>Mulai</label><select name="when"><option value="now">Sekarang</option><option value="later">Jadwalkan…</option></select></div>
        <div class="field hidden" data-at><label>Waktu mulai</label><input type="datetime-local" name="startAt"></div>
        <div class="field"><label>Durasi</label><select name="duration">
          <option value="">Sampai dikembalikan manual</option><option value="60">1 jam</option><option value="120">2 jam</option><option value="180" selected>3 jam</option>
          <option value="360">6 jam</option><option value="720">12 jam</option><option value="1440">1 hari</option><option value="custom">Lainnya…</option></select></div>
        <div class="field hidden" data-custom><label>Durasi (menit)</label><input type="number" name="customMin" min="1" value="90"></div>
      </div>
      <p class="small muted">Kondisi queue sebelumnya dicatat, lalu dikembalikan otomatis saat durasi habis atau saat Anda klik "Kembalikan normal".</p>`, {
      submitText: 'Aktifkan',
      onSubmit: async (f) => {
        const d = formData(f);
        const durationMin = d.duration === 'custom' ? Number(d.customMin) : d.duration ? Number(d.duration) : null;
        const startAt = d.when === 'later' ? (d.startAt ? new Date(d.startAt).toISOString() : (() => { throw new Error('Isi waktu mulai'); })()) : null;
        return api.post(`${base}/bw-profiles/${p.id}/activate`, { durationMin, startAt });
      },
    });
    if (ok) { toast(`Mode Event "${p.name}" ${ok.activation.status === 'active' ? 'aktif' : 'dijadwalkan'}`, 'ok'); loaders.event(); }
  }
  document.addEventListener('change', (e) => {
    const f = e.target.form;
    if (!f) return;
    if (e.target.name === 'when') f.querySelector('[data-at]').classList.toggle('hidden', e.target.value !== 'later');
    if (e.target.name === 'duration') f.querySelector('[data-custom]').classList.toggle('hidden', e.target.value !== 'custom');
  });

  refreshEvent().catch(() => {});
})();
