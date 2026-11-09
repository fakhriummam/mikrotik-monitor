/* Halaman detail router: inti (tab, tabel, socket), Ringkasan, Riwayat, tabel monitoring. */
(function () {
  const { api, esc, fmt, barClass, topbar, run, confirmBox, listenAlerts, cssVar, modal } = App;
  topbar('home');
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (!id) { location.href = '/index.html'; return; }
  const base = `/routers/${id}`;

  /* ---------- helper tabel ---------- */
  function table(el, cols, rows, opts = {}) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!rows.length) { el.innerHTML = `<div class="card empty">${esc(opts.empty || 'Tidak ada data')}</div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th class="${c.cls || ''}">${esc(c.h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-i="${i}" class="${opts.rowClass ? opts.rowClass(r) : ''}">${cols.map((c) => `<td class="${c.cls || ''}">${c.v(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${opts.footer ? `<div class="small muted" style="margin-top:6px">${opts.footer}</div>` : ''}`;
    if (opts.actions) {
      el.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = (e) => {
          e.preventDefault();
          const row = rows[Number(b.closest('tr').dataset.i)];
          const fn = opts.actions[b.dataset.act];
          if (fn) fn(row, b);
        };
      });
    }
  }
  const filterRows = (rows, q) => {
    q = String(q || '').trim().toLowerCase();
    return q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)) : rows;
  };

  /* ---------- tab ---------- */
  const loaders = {};
  const leaveHandlers = {};
  let activeTab = 'overview';
  function showTab(name) {
    if (!document.querySelector(`[data-panel="${name}"]`)) name = 'overview';
    if (leaveHandlers[activeTab]) leaveHandlers[activeTab]();
    activeTab = name;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    history.replaceState(null, '', `?id=${id}#${name}`);
    if (loaders[name]) loaders[name]().catch((e) => App.toast(e.message, 'error', 6000));
  }
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

  /** Pemilih device (DHCP + hotspot + PPPoE). Mengisi input target. */
  async function pickDevice() {
    const list = await api.get(`${base}/devices`);
    const rows = list.map((d, i) => `<tr data-i="${i}" style="cursor:pointer"><td class="mono">${esc(d.ip)}</td><td>${esc(d.label)}</td><td class="mono small">${esc(d.mac || '')}</td><td><span class="badge">${esc(d.source)}</span></td></tr>`).join('');
    let picked = null;
    const p = modal('Pilih Device', `<input placeholder="Cari…" data-q style="margin-bottom:10px"><div class="table-wrap" style="max-height:50vh;overflow:auto"><table><thead><tr><th>IP</th><th>Nama</th><th>MAC</th><th>Sumber</th></tr></thead><tbody>${rows || '<tr><td colspan=4 class="empty">Tidak ada device</td></tr>'}</tbody></table></div>`);
    const form = document.querySelector('.modal-backdrop:last-child form');
    form.querySelector('[data-q]').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      form.querySelectorAll('tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    };
    form.querySelectorAll('tbody tr[data-i]').forEach((tr) => { tr.onclick = () => { picked = list[Number(tr.dataset.i)]; form._close(picked); }; });
    await p;
    return picked;
  }

  window.RT = { id, base, table, filterRows, loaders, leaveHandlers, pickDevice, get router() { return router; }, showTab };

  /* ---------- info router ---------- */
  let router = null;
  async function loadRouter() {
    router = await api.get(base);
    document.title = `${router.name} — MikroTik Monitor`;
    document.getElementById('rname').textContent = router.name;
    updateHeader(router);
  }
  function updateHeader(s) {
    document.getElementById('statusDot').className = 'dot ' + (s.online ? 'on' : 'off');
    document.getElementById('rmeta').textContent = [router.host, s.board, s.version && 'RouterOS ' + s.version].filter(Boolean).join(' · ');
    const off = document.getElementById('offline');
    off.classList.toggle('hidden', !!s.online);
    off.innerHTML = s.online ? '' : `<b>Router offline.</b> <span>${esc(s.lastError || (router.enabled ? 'Menghubungkan…' : 'Pemantauan dinonaktifkan'))}</span>`;
  }
  document.getElementById('editBtn').onclick = async () => { if (await openRouterForm(router)) loadRouter(); };
  document.getElementById('delBtn').onclick = async () => {
    if (!(await confirmBox('Hapus router?', `Router "${router.name}" beserta riwayat & profilnya akan dihapus dari aplikasi (konfigurasi di MikroTik tidak berubah).`, 'Hapus'))) return;
    await run(() => api.del(base));
    location.href = '/index.html';
  };

  /* ---------- Ringkasan & chart live ---------- */
  const MAX_POINTS = 60;
  const live = {}; // iface -> [{t, rx, tx}]
  let liveChart = null;
  const ifaceSel = document.getElementById('liveIface');

  function chartColors() { return { rx: cssVar('--chart-rx'), tx: cssVar('--chart-tx'), grid: cssVar('--border'), text: cssVar('--muted') }; }
  function baseOpts(yFmt) {
    const c = chartColors();
    return {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: c.text, boxWidth: 12 } }, tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${yFmt(ctx.parsed.y)}` } } },
      scales: {
        x: { ticks: { color: c.text, maxTicksLimit: 8, maxRotation: 0 }, grid: { color: c.grid } },
        y: { beginAtZero: true, ticks: { color: c.text, callback: (v) => yFmt(v) }, grid: { color: c.grid } },
      },
    };
  }
  RT.baseOpts = baseOpts;
  RT.chartColors = chartColors;

  function ensureLiveChart() {
    if (liveChart) return;
    const c = chartColors();
    liveChart = new Chart(document.getElementById('liveChart'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Download (rx)', data: [], borderColor: c.rx, backgroundColor: c.rx + '22', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
        { label: 'Upload (tx)', data: [], borderColor: c.tx, backgroundColor: c.tx + '22', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      ] },
      options: baseOpts(fmt.bps),
    });
  }
  function drawLive() {
    ensureLiveChart();
    const pts = live[ifaceSel.value] || [];
    liveChart.data.labels = pts.map((p) => new Date(p.t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    liveChart.data.datasets[0].data = pts.map((p) => p.rx);
    liveChart.data.datasets[1].data = pts.map((p) => p.tx);
    liveChart.update('none');
    const last = pts[pts.length - 1];
    document.getElementById('liveRx').textContent = '↓ ' + fmt.bps(last && last.rx);
    document.getElementById('liveTx').textContent = '↑ ' + fmt.bps(last && last.tx);
  }
  ifaceSel.onchange = drawLive;

  function onStats(s) {
    updateHeader(s);
    if (!s.online) return;
    const memPct = s.memTotal ? (s.memUsed / s.memTotal) * 100 : null;
    document.getElementById('sCpu').textContent = fmt.pct(s.cpu);
    document.getElementById('bCpu').style.width = (s.cpu || 0) + '%';
    document.getElementById('bCpu').className = barClass(s.cpu);
    document.getElementById('sMem').textContent = fmt.pct(memPct);
    document.getElementById('bMem').style.width = (memPct || 0) + '%';
    document.getElementById('bMem').className = barClass(memPct);
    document.getElementById('sMemD').textContent = `${fmt.bytes(s.memUsed)} / ${fmt.bytes(s.memTotal)}`;
    document.getElementById('sTemp').textContent = s.temp != null ? `${s.temp}°C` : '–';
    document.getElementById('sUp').textContent = s.uptime || '–';
    document.getElementById('sHs').textContent = s.hotspotActive ?? '–';
    document.getElementById('sPpp').textContent = s.pppActive ?? '–';

    const tr = new Map((s.traffic || []).map((t) => [t.name, t]));
    for (const t of s.traffic || []) {
      (live[t.name] = live[t.name] || []).push({ t: s.ts, rx: t.rx, tx: t.tx });
      if (live[t.name].length > MAX_POINTS) live[t.name].shift();
    }
    const names = (s.traffic || []).map((t) => t.name);
    if (names.join() !== [...ifaceSel.options].map((o) => o.value).join()) {
      const cur = ifaceSel.value;
      ifaceSel.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join('');
      if (names.includes(cur)) ifaceSel.value = cur;
    }
    document.getElementById('ifaceBody').innerHTML = (s.interfaces || []).map((i) => {
      const t = tr.get(i.name);
      const st = i.disabled ? '<span class="badge">disabled</span>' : i.running ? '<span class="badge ok">running</span>' : '<span class="badge danger">down</span>';
      return `<tr><td>${esc(i.name)}</td><td class="muted">${esc(i.type)}</td><td>${st}</td><td class="num">${t ? fmt.bps(t.rx) : '–'}</td><td class="num">${t ? fmt.bps(t.tx) : '–'}</td></tr>`;
    }).join('');
    if (activeTab === 'overview') drawLive();
  }
  loaders.overview = async () => { const s = await api.get(`${base}/stats`).catch(() => null); if (s) onStats(s); };

  /* ---------- Riwayat ---------- */
  const hCharts = {};
  function upsertChart(key, canvasId, datasets, labels, yFmt, extra = {}) {
    if (hCharts[key]) hCharts[key].destroy();
    const opts = baseOpts(yFmt);
    if (extra.yMax) opts.scales.y.max = extra.yMax;
    hCharts[key] = new Chart(document.getElementById(canvasId), { type: 'line', data: { labels, datasets }, options: opts });
  }
  loaders.history = async () => {
    const range = document.getElementById('hRange').value;
    const ifSel = document.getElementById('hIface');
    const d = await api.get(`${base}/history?range=${range}${ifSel.value ? '&iface=' + encodeURIComponent(ifSel.value) : ''}`);
    ifSel.innerHTML = d.ifaces.length ? d.ifaces.map((n) => `<option ${n === d.iface ? 'selected' : ''}>${esc(n)}</option>`).join('') : '<option value="">(belum ada data)</option>';
    const lab = (t) => new Date(t).toLocaleString('id-ID', range === '1h' || range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', hour: '2-digit' });
    const c = chartColors();
    const ds = (label, data, color, fill = true) => ({ label, data, borderColor: color, backgroundColor: color + '22', fill, tension: 0.3, pointRadius: 0, borderWidth: 2 });
    upsertChart('t', 'hTraffic', [ds('Download', d.traffic.map((x) => x.rx), c.rx), ds('Upload', d.traffic.map((x) => x.tx), c.tx)], d.traffic.map((x) => lab(x.t)), fmt.bps);
    upsertChart('r', 'hRes', [ds('CPU %', d.samples.map((x) => x.cpu), c.rx, false), ds('RAM %', d.samples.map((x) => x.mem), cssVar('--warn'), false)], d.samples.map((x) => lab(x.t)), (v) => Math.round(v) + '%', { yMax: 100 });
    upsertChart('u', 'hUsers', [ds('Hotspot', d.samples.map((x) => x.hotspot), c.rx, false), ds('PPPoE', d.samples.map((x) => x.ppp), c.tx, false)], d.samples.map((x) => lab(x.t)), (v) => Math.round(v));
  };
  document.getElementById('hRange').onchange = () => loaders.history();
  document.getElementById('hIface').onchange = () => loaders.history();

  /* ---------- tabel monitoring sederhana ---------- */
  const cache = {};
  const simple = {
    hsactive: {
      url: '/hotspot-active', empty: 'Tidak ada user hotspot yang online',
      cols: [
        { h: 'User', v: (r) => `<b>${esc(r.user)}</b>` },
        { h: 'IP', v: (r) => `<span class="mono">${esc(r.address)}</span>` },
        { h: 'MAC', v: (r) => `<span class="mono small">${esc(r['mac-address'])}</span>` },
        { h: 'Server', v: (r) => esc(r.server) },
        { h: 'Uptime', v: (r) => esc(r.uptime) },
        { h: 'Download', cls: 'num', v: (r) => fmt.bytes(r['bytes-out']) },
        { h: 'Upload', cls: 'num', v: (r) => fmt.bytes(r['bytes-in']) },
        { h: '', cls: 'actions', v: () => '<button class="btn sm danger" data-act="kick">Kick</button>' },
      ],
      actions: { kick: (r) => kick('/hotspot-active/kick', r, r.user, 'hsactive') },
    },
    ppp: {
      url: '/ppp-active', empty: 'Tidak ada koneksi PPPoE aktif',
      cols: [
        { h: 'Nama', v: (r) => `<b>${esc(r.name)}</b>` },
        { h: 'Service', v: (r) => esc(r.service) },
        { h: 'IP', v: (r) => `<span class="mono">${esc(r.address)}</span>` },
        { h: 'Caller ID', v: (r) => `<span class="mono small">${esc(r['caller-id'])}</span>` },
        { h: 'Uptime', v: (r) => esc(r.uptime) },
        { h: '', cls: 'actions', v: () => '<button class="btn sm danger" data-act="kick">Putuskan</button>' },
      ],
      actions: { kick: (r) => kick('/ppp-active/kick', r, r.name, 'ppp') },
    },
    dhcp: {
      url: '/dhcp-leases', empty: 'Tidak ada DHCP lease',
      cols: [
        { h: 'IP', v: (r) => `<span class="mono">${esc(r.address)}</span>` },
        { h: 'MAC', v: (r) => `<span class="mono small">${esc(r['mac-address'])}</span>` },
        { h: 'Hostname', v: (r) => esc(r['host-name'] || '–') },
        { h: 'Server', v: (r) => esc(r.server) },
        { h: 'Status', v: (r) => `<span class="badge ${r.status === 'bound' ? 'ok' : ''}">${esc(r.status || '–')}</span>` },
        { h: 'Tipe', v: (r) => (r.dynamic === 'true' ? 'dinamis' : 'statis') },
        { h: 'Kedaluwarsa', v: (r) => esc(r['expires-after'] || '–') },
      ],
    },
    logs: {
      url: '/logs', empty: 'Log kosong',
      cols: [
        { h: 'Waktu', v: (r) => `<span class="mono small nowrap">${esc(r.time)}</span>` },
        { h: 'Topik', v: (r) => `<span class="badge ${/error|critical/.test(r.topics) ? 'danger' : /warning/.test(r.topics) ? 'warn' : ''}">${esc(r.topics)}</span>` },
        { h: 'Pesan', v: (r) => esc(r.message) },
      ],
    },
  };
  async function kick(url, row, label, key) {
    if (!(await confirmBox('Putuskan koneksi?', `Putuskan "${label}"? User bisa login lagi setelahnya.`, 'Putuskan'))) return;
    await run(() => api.post(base + url, { itemId: row['.id'], label }), `${label} diputus`);
    loaders[key]();
  }
  for (const [key, def] of Object.entries(simple)) {
    const render = () => table(`${key}Table`, def.cols, filterRows(cache[key] || [], document.querySelector(`[data-search="${key}"]`).value), { empty: def.empty, actions: def.actions, footer: `${(cache[key] || []).length} entri` });
    loaders[key] = async () => { cache[key] = await api.get(base + def.url); render(); };
    document.querySelector(`[data-search="${key}"]`).oninput = render;
    document.querySelector(`[data-refresh="${key}"]`).onclick = () => loaders[key]();
  }

  /* ---------- Alert & audit ---------- */
  loaders.alerts = async () => {
    const [al, au] = await Promise.all([api.get(`${base}/alerts`), api.get(`${base}/audit`)]);
    const badge = (t) => ({ down: 'danger', cpu: 'danger', mem: 'danger', iface_down: 'danger', up: 'ok', iface_up: 'ok', event_on: 'warn', event_off: 'info' }[t] || '');
    document.getElementById('alertList').innerHTML = al.length ? al.map((a) => `<div class="alert-row"><span class="small muted nowrap">${fmt.time(a.ts)}</span><span class="badge ${badge(a.type)}">${esc(a.type)}</span><span class="msg">${esc(a.message)}</span></div>`).join('') : '<div class="empty">Belum ada alert</div>';
    document.getElementById('auditList').innerHTML = au.length ? au.map((a) => {
      let d = a.detail; try { const j = JSON.parse(d); d = typeof j === 'string' ? j : Object.entries(j).map(([k, v]) => `${k}: ${v}`).join(', '); } catch { /* biarkan */ }
      return `<div class="alert-row"><span class="small muted nowrap">${fmt.time(a.ts)}</span><b class="nowrap">${esc(a.user || '-')}</b><span><span class="mono small">${esc(a.action)}</span> <span class="muted small">${esc(d)}</span></span></div>`;
    }).join('') : '<div class="empty">Belum ada aksi</div>';
  };

  /* ---------- socket ---------- */
  const socket = io();
  socket.on('connect', () => socket.emit('subscribe', `router:${id}`));
  socket.on('stats', onStats);
  socket.on('alert', (a) => { if (a.router_id === id && activeTab === 'alerts') loaders.alerts(); if (a.router_id === id && /^event/.test(a.type) && RT.refreshEvent) RT.refreshEvent(); });
  listenAlerts(socket);
  document.addEventListener('themechange', () => { if (liveChart) { liveChart.destroy(); liveChart = null; drawLive(); } if (activeTab === 'history') loaders.history(); });

  loadRouter().then(() => {
    loaders.overview();
    const tab = location.hash.slice(1);
    // tunggu script tab lain (bandwidth.js, hotspot.js) terdaftar
    setTimeout(() => showTab(tab || 'overview'), 0);
  }).catch((e) => { App.toast(e.message, 'error'); });
})();
