// 集中配置：全部来自环境变量，启动时校验
const path = require('path');

// 轻量 .env 加载（避免额外依赖）
const fs = require('fs');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const required = ['JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[FATAL] 缺少必需环境变量: ${key}，请参照 .env.example 配置`);
    process.exit(1);
  }
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET,
  dbPath: path.resolve(__dirname, '..', process.env.DB_PATH || './data/assets.db'),
  uploadDir: path.resolve(__dirname, '..', process.env.UPLOAD_DIR || './uploads'),
  accessTtl: process.env.ACCESS_TOKEN_TTL || '2h',
  refreshTtlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '14', 10),
  cookieName: process.env.COOKIE_NAME || 'am_session',
  // 泽曦工作台统一账号同步密钥（/api/internal/account-sync 的 Bearer 密钥）
  syncKey: process.env.ZC_SYNC_KEY || '',
};
