# MikroTik Monitor & Manajemen

Aplikasi web untuk **memantau dan mengelola banyak router MikroTik** lewat RouterOS API.

## Fitur
- **Dashboard multi-router**: status online/offline, CPU, RAM, suhu, uptime, jumlah user Hotspot & PPPoE (realtime).
- **Ringkasan per router**: grafik trafik live per interface, status interface.
- **Riwayat** (1 jam / 24 jam / 7 hari / 30 hari): trafik, CPU/RAM, jumlah user online.
- **Bandwidth**:
  - Batasi bandwidth satu **subnet** atau satu **device** (Simple Queue).
  - **Fokuskan satu device**: device mendapat bandwidth terjamin + prioritas 1, device lain di network yang sama berbagi sisanya.
  - Edit / nonaktifkan / hapus Simple Queue yang ada, lihat rate live.
- **Mode Event**: simpan profil aturan bandwidth (limit, fokus device, ubah/nonaktifkan queue lama, ubah rate profil hotspot), aktifkan sekarang atau terjadwal, dengan durasi → **otomatis kembali normal**.
- **User Hotspot**: tambah/edit/hapus, aktif/nonaktif, reset pemakaian, batas waktu & kuota, kunci MAC.
- **Voucher**: generate massal (prefix, panjang, jenis karakter, profil, batas), **cetak** kartu voucher, ekspor CSV, hapus per batch.
- **Profil Hotspot**: rate-limit, device per akun, session timeout.
- **Hotspot aktif / PPPoE aktif** (kick), **DHCP lease**, **Log** router.
- **Notifikasi Telegram**: router down/up, CPU/RAM tinggi, interface down/up, Mode Event mulai/selesai.
- Login admin, riwayat aksi (audit log), tema terang/gelap, tampilan mobile.

## Instalasi
Butuh **Node.js 18+**.

```bash
git clone https://github.com/fakhriummam/mikrotik-monitor.git
cd mikrotik-monitor
npm install
cp .env.example .env     # lalu ubah APP_SECRET, ADMIN_USER, ADMIN_PASS
npm start
```

Buka `http://<ip-server>:3000`, login dengan `ADMIN_USER` / `ADMIN_PASS` dari `.env` (default `admin` / `admin123` — segera ganti di menu Pengaturan).

**Coba tanpa perangkat:** jalankan `npm run simulate`, atau tambahkan router dengan host berakhiran `.sim` (mis. `demo.sim`). Host `xxx.down.sim` mensimulasikan router mati.

## Menyiapkan MikroTik
1. Aktifkan API (di Terminal MikroTik):
   ```
   /ip service set api disabled=no address=<IP-server-aplikasi>/32
   ```
   Untuk API-SSL (port 8729) pakai `/ip service set api-ssl ...` (butuh sertifikat).
2. Buat user khusus untuk aplikasi:
   ```
   /user group add name=monitor policy=read,write,api,test,!local,!telnet,!ssh,!ftp,!reboot,!policy,!password,!sniff,!sensitive,!romon
   /user add name=monitor group=monitor password=<password-kuat>
   ```
   - Hanya monitoring → cukup `read,api,test`.
   - Kick user, bandwidth, Mode Event, user hotspot & voucher → butuh `write`.
   - Melihat **password** user hotspot di tabel/voucher butuh policy `sensitive`.
3. Tambahkan router di dashboard → **Tes koneksi** → Simpan.

## Telegram
1. Buat bot lewat **@BotFather**, salin token.
2. Kirim pesan ke bot (atau tambahkan bot ke grup), lalu buka `https://api.telegram.org/bot<TOKEN>/getUpdates` untuk melihat `chat.id`.
3. Isi di **Pengaturan → Notifikasi Telegram** dan klik **Kirim tes**.

## Catatan teknis
- Queue buatan aplikasi diberi komentar `mtmon:...` — queue yang Anda buat manual tidak disentuh kecuali Anda sendiri yang mengubahnya.
- Mode Event mencatat kondisi awal (snapshot). Jika salah satu aturan gagal diterapkan, semua perubahan dibatalkan otomatis.
- Fokus device membuat 3 queue: `<nama>-induk` (target network, max = total), `<nama>-device` (prioritas 1, limit-at = terjamin), `<nama>-lainnya` (prioritas 8). Jika ada FastTrack di firewall, trafik yang ter-fasttrack melewati Simple Queue — nonaktifkan FastTrack agar limit berlaku.
- Data tersimpan di `data/monitor.db` (SQLite). Riwayat dihapus otomatis setelah `RETENTION_DAYS` hari.
- Password router dienkripsi (AES-256-GCM) memakai `APP_SECRET` — jangan ganti `APP_SECRET` setelah router ditambahkan, atau password router harus diisi ulang.
- Agar berjalan terus di server, gunakan `pm2` atau service systemd:
  ```bash
  npm i -g pm2 && pm2 start src/server.js --name mikrotik-monitor && pm2 save
  ```

## Struktur
```
src/server.js            Express + Socket.IO + session
src/poller.js            polling tiap router, simpan riwayat, cek alert
src/bandwidth.js         Simple Queue, fokus device, Mode Event + scheduler
src/routeros/client.js   koneksi RouterOS API (node-routeros)
src/routeros/simulator.js router palsu untuk demo/pengujian
src/routes/*.js          REST API
public/                  frontend (HTML + JS + Chart.js)
```
