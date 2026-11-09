const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  port: Number(process.env.PORT) || 3000,
  appSecret: process.env.APP_SECRET || 'dev-secret-change-me-dev-secret-change-me',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin123',
  pollInterval: Math.max(2, Number(process.env.POLL_INTERVAL) || 5) * 1000,
  retentionDays: Number(process.env.RETENTION_DAYS) || 30,
  simulate: String(process.env.SIMULATE).toLowerCase() === 'true',
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
};

if (!process.env.APP_SECRET) {
  console.warn('[config] APP_SECRET belum diatur di .env — memakai kunci default (tidak aman untuk produksi).');
}

module.exports = config;
