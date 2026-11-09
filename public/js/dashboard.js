(function () {
  const { api, esc, fmt, barClass, topbar, listenAlerts } = App;
  topbar('home');
  const routers = new Map();
  const box = document.getElementById('routers');

  function card(r) {
    const memPct = r.memTotal ? (r.memUsed / r.memTotal) * 100 : null;
    const status = !r.enabled ? '<span class="badge">Nonaktif</span>' : r.online ? '<span class="badge ok">Online</span>' : '<span class="badge danger">Offline</span>';
    return `<a class="card router-card" href="/router.html?id=${r.id}" data-id="${r.id}">
      <div class="title"><span class="dot ${r.online ? 'on' : r.enabled ? 'off' : ''}"></span>${esc(r.name)}<span class="spacer" style="flex:1"></span>${status}</div>
      <div class="meta">${esc(r.host)}${r.board ? ' · ' + esc(r.board) : ''}${r.version ? ' · v' + esc(r.version.split(' ')[0]) : ''}</div>
      ${r.online ? `<div class="kv">
        <div><div class="k">CPU</div><div class="v">${fmt.pct(r.cpu)}</div><div class="bar"><span class="${barClass(r.cpu)}" style="width:${r.cpu || 0}%"></span></div></div>
        <div><div class="k">RAM</div><div class="v">${fmt.pct(memPct)}</div><div class="bar"><span class="${barClass(memPct)}" style="width:${memPct || 0}%"></span></div></div>
        <div><div class="k">Hotspot aktif</div><div class="v">${r.hotspotActive ?? '–'}</div></div>
        <div><div class="k">PPPoE aktif</div><div class="v">${r.pppActive ?? '–'}</div></div>
        <div><div class="k">Uptime</div><div class="v small">${esc(r.uptime || '–')}</div></div>
        <div><div class="k">Suhu</div><div class="v">${r.temp != null ? r.temp + '°C' : '–'}</div></div>
      </div>` : `<div class="small muted">${esc(r.lastError || 'Menghubungkan…')}</div>`}
    </a>`;
  }

  function render() {
    const list = [...routers.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) {
      box.innerHTML = `<div class="card empty" style="grid-column:1/-1">Belum ada router. Klik <b>+ Tambah Router</b> untuk mulai memantau.</div>`;
    } else box.innerHTML = list.map(card).join('');
    const on = list.filter((r) => r.online).length;
    document.getElementById('totals').textContent = list.length ? `${on} online · ${list.length - on} offline/nonaktif` : '';
  }

  async function load() {
    const list = await api.get('/routers');
    routers.clear();
    for (const r of list) routers.set(r.id, r);
    render();
  }

  async function loadAlerts() {
    const list = await api.get('/settings/alerts');
    document.getElementById('alerts').innerHTML = list.length
      ? list.slice(0, 8).map((a) => `<div class="alert-row"><span class="small muted nowrap">${fmt.time(a.ts)}</span><b class="nowrap">${esc(a.router_name || '-')}</b><span class="msg">${esc(a.message)}</span></div>`).join('')
      : '<div class="empty">Belum ada alert.</div>';
  }

  document.getElementById('addBtn').onclick = async () => { if (await openRouterForm()) load(); };

  const socket = io();
  socket.on('connect', () => socket.emit('subscribe', 'dashboard'));
  socket.on('summary', (s) => {
    const cur = routers.get(s.id);
    if (cur) { routers.set(s.id, { ...cur, ...s }); render(); }
  });
  socket.on('alert', () => loadAlerts());
  listenAlerts(socket);

  load();
  loadAlerts();
  setInterval(load, 60000);
})();
