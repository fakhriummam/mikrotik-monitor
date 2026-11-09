const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const config = require('./config');
require('./db');
const { authRouter, requireAuth } = require('./auth');
const poller = require('./poller');
const alerts = require('./alerts');
const bandwidth = require('./bandwidth');

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const sessionMiddleware = session({
  name: 'mtmon.sid',
  secret: config.appSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 },
});
app.use(sessionMiddleware);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// halaman HTML: wajib login kecuali halaman login
const PAGES = ['index.html', 'router.html', 'settings.html', 'voucher-print.html'];
app.get('/', (req, res) => res.redirect(req.session.user ? '/index.html' : '/login.html'));
app.get(PAGES.map((p) => '/' + p), (req, res, next) => (req.session.user ? next() : res.redirect('/login.html')));
app.use('/vendor/chart.js', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api', requireAuth);
app.use('/api/settings', require('./routes/settings'));
app.use('/api/routers', require('./routes/routers'));
app.use('/api/routers/:id', require('./routes/data'));
app.use('/api/routers/:id', require('./routes/hotspot'));
app.use('/api/routers/:id', require('./routes/bandwidth'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err.message);
  // pesan error dari RouterOS diteruskan supaya user tahu penyebabnya
  res.status(status === 500 ? 502 : status).json({ error: err.message || 'Terjadi kesalahan' });
});

const server = http.createServer(app);
const io = new Server(server);
io.engine.use(sessionMiddleware);
io.use((socket, next) => (socket.request.session && socket.request.session.user ? next() : next(new Error('unauthorized'))));
io.on('connection', (socket) => {
  socket.join('auth');
  socket.on('subscribe', (room) => {
    for (const r of socket.rooms) if (r !== socket.id && r !== 'auth') socket.leave(r);
    if (room === 'dashboard' || /^router:\d+$/.test(String(room))) socket.join(room);
  });
});

alerts.setIo(io);
poller.startAll(io);
bandwidth.startScheduler();

server.listen(config.port, () => {
  console.log(`MikroTik Monitor berjalan di http://localhost:${config.port}${config.simulate ? '  (MODE SIMULASI)' : ''}`);
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));
