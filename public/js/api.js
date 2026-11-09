/* Utilitas bersama: fetch API, toast, modal, format angka, tema, topbar. */
(function () {
  const api = async (method, url, body) => {
    const res = await fetch('/api' + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && !url.startsWith('/auth/') && !location.pathname.endsWith('/login.html')) {
      location.href = '/login.html';
      throw new Error('Sesi habis');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
  api.get = (u) => api('GET', u);
  api.post = (u, b) => api('POST', u, b || {});
  api.put = (u, b) => api('PUT', u, b || {});
  api.del = (u) => api('DELETE', u);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, type = 'info', ms = 3500) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  /** Jalankan aksi async dengan toast sukses/gagal. */
  async function run(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (e) {
      toast(e.message, 'error', 6000);
      throw e;
    }
  }

  /**
   * Modal sederhana. html = isi form. onSubmit(form) -> promise; jika resolve, modal ditutup.
   */
  function modal(title, html, { submitText = 'Simpan', onSubmit, danger = false, wide = false } = {}) {
    return new Promise((resolve) => {
      const bd = document.createElement('div');
      bd.className = 'modal-backdrop';
      bd.innerHTML = `<form class="modal" ${wide ? 'style="width:min(860px,100%)"' : ''}>
        <h2>${esc(title)}</h2><div class="modal-body">${html}</div>
        <div class="error-text"></div>
        <div class="btn-row"><button type="button" class="btn" data-cancel>Batal</button>
        ${onSubmit ? `<button class="btn ${danger ? 'danger solid' : 'primary'}" type="submit">${esc(submitText)}</button>` : ''}</div></form>`;
      document.body.appendChild(bd);
      const form = bd.querySelector('form');
      const close = (v) => { bd.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      bd.addEventListener('mousedown', (e) => { if (e.target === bd) close(null); });
      form.querySelector('[data-cancel]').onclick = () => close(null);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = form.querySelector('[type=submit]');
        btn.disabled = true;
        form.querySelector('.error-text').textContent = '';
        try { close(await onSubmit(form)); } catch (err) { form.querySelector('.error-text').textContent = err.message; btn.disabled = false; }
      };
      const first = form.querySelector('input, select, textarea');
      if (first) first.focus();
      form._close = close;
    });
  }

  function confirmBox(title, text, okText = 'Ya, lanjutkan') {
    return modal(title, `<p>${esc(text)}</p>`, { submitText: okText, danger: true, onSubmit: async () => true });
  }

  const formData = (form) => {
    const o = {};
    for (const el of form.querySelectorAll('[name]')) {
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else o[el.name] = el.value;
    }
    return o;
  };

  const fmt = {
    bps(v) {
      if (v === null || v === undefined || isNaN(v)) return '–';
      const u = ['bps', 'Kbps', 'Mbps', 'Gbps'];
      let i = 0; v = Number(v);
      while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
      return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
    },
    bytes(v) {
      v = Number(v);
      if (!v) return '0 B';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
    },
    pct(v) { return v === null || v === undefined ? '–' : `${Math.round(v)}%`; },
    time(ts) { return ts ? new Date(ts).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '–'; },
    rate(s) { // "5M/20M" -> "↑5M ↓20M"
      if (!s || s === '0/0') return 'tanpa batas';
      const [u, d] = String(s).split('/');
      return `↑${u === '0' ? '∞' : u} ↓${d === '0' ? '∞' : d}`;
    },
  };

  const barClass = (p) => (p >= 90 ? 'danger' : p >= 70 ? 'warn' : '');

  /* ---- tema ---- */
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  let theme = null;
  try { theme = localStorage.getItem('theme'); } catch { /* abaikan */ }
  applyTheme(theme);
  function toggleTheme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('theme', next); } catch { /* abaikan */ }
    document.dispatchEvent(new CustomEvent('themechange'));
  }
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  /* ---- topbar ---- */
  function topbar(active) {
    const el = document.createElement('header');
    el.className = 'topbar';
    el.innerHTML = `
      <a class="brand" href="/index.html"><span class="logo">MT</span>MikroTik Monitor</a>
      <nav>
        <a href="/index.html" class="${active === 'home' ? 'active' : ''}">Dashboard</a>
        <a href="/settings.html" class="${active === 'settings' ? 'active' : ''}">Pengaturan</a>
      </nav>
      <span class="spacer"></span>
      <span class="muted small" id="whoami"></span>
      <button class="btn sm ghost" id="themeBtn" title="Ganti tema terang/gelap" aria-label="Ganti tema"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
      <button class="btn sm" id="logoutBtn">Keluar</button>`;
    document.body.prepend(el);
    el.querySelector('#themeBtn').onclick = toggleTheme;
    el.querySelector('#logoutBtn').onclick = async () => { await api.post('/auth/logout'); location.href = '/login.html'; };
    api.get('/auth/me').then((r) => { el.querySelector('#whoami').textContent = r.user.username; }).catch(() => {});
  }

  /** Notifikasi alert realtime di semua halaman */
  function listenAlerts(socket) {
    socket.on('alert', (a) => {
      const type = ['down', 'cpu', 'mem', 'iface_down'].includes(a.type) ? 'error' : a.type === 'event_on' ? 'warn' : 'ok';
      toast(`${a.router}: ${a.message}`, type, 8000);
    });
  }

  window.App = { api, esc, toast, run, modal, confirmBox, formData, fmt, barClass, topbar, toggleTheme, cssVar, listenAlerts };
})();
