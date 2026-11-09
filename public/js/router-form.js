/* Modal tambah / edit router (dipakai di dashboard & halaman detail). */
window.openRouterForm = function (existing) {
  const { esc, api, modal, formData, toast } = App;
  const r = existing || { port: 8728, enabled: true };
  const html = `
    <div class="form-grid">
      <div class="field"><label>Nama router</label><input name="name" required value="${esc(r.name || '')}" placeholder="Kantor Pusat"></div>
      <div class="field"><label>Host / IP <span class="hint">(IP / DNS)</span></label><input name="host" required value="${esc(r.host || '')}" placeholder="192.168.88.1"></div>
      <div class="field"><label>Port API</label><input name="port" type="number" value="${esc(r.port || 8728)}"></div>
      <div class="field"><label>Username</label><input name="username" required value="${esc(r.username || '')}" autocomplete="off"></div>
      <div class="field"><label>Password ${existing ? '<span class="hint">(kosongkan jika tidak diubah)</span>' : ''}</label><input name="password" type="password" autocomplete="new-password"></div>
      <div class="field"><label>Interface dipantau <span class="hint">(alert up/down, pisah koma)</span></label><input name="watch_ifaces" value="${esc(r.watch_ifaces || '')}" placeholder="ether1,pppoe-out1"></div>
      <div class="field full btn-row">
        <label class="check"><input type="checkbox" name="use_ssl" ${r.use_ssl ? 'checked' : ''}> Pakai API-SSL (port 8729)</label>
        <label class="check"><input type="checkbox" name="enabled" ${r.enabled !== false ? 'checked' : ''}> Aktif dipantau</label>
      </div>
      <div class="field full"><button type="button" class="btn sm" data-test>Tes koneksi</button> <span class="small muted" data-test-result></span></div>
    </div>
    <p class="small muted">Tip: untuk mencoba tanpa perangkat, isi host <span class="mono">demo.sim</span> (router simulasi).</p>`;
  const p = modal(existing ? `Edit ${r.name}` : 'Tambah Router', html, {
    onSubmit: async (form) => {
      const d = formData(form);
      if (existing) await api.put(`/routers/${existing.id}`, d);
      else await api.post('/routers', d);
      toast(existing ? 'Router diperbarui' : 'Router ditambahkan', 'ok');
      return true;
    },
  });
  const form = document.querySelector('.modal-backdrop:last-child form');
  form.querySelector('[name=use_ssl]').onchange = (e) => {
    const port = form.querySelector('[name=port]');
    if (port.value === '8728' || port.value === '8729' || !port.value) port.value = e.target.checked ? 8729 : 8728;
  };
  form.querySelector('[data-test]').onclick = async (e) => {
    const out = form.querySelector('[data-test-result]');
    e.target.disabled = true;
    out.textContent = 'Menghubungkan…';
    try {
      const r2 = await api.post('/routers/test', { ...formData(form), id: existing && existing.id });
      out.innerHTML = `<span class="badge ok">Berhasil</span> ${esc(r2.identity || '')} · RouterOS ${esc(r2.version || '')} · ${esc(r2.board || '')}`;
    } catch (ex) {
      out.innerHTML = `<span class="badge danger">Gagal</span> ${esc(ex.message)}`;
    } finally { e.target.disabled = false; }
  };
  return p;
};
