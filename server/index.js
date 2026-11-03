// 应用入口：全栈单体（API + 静态前端 + 上传文件）
const express = require('express');
const path = require('path');
const config = require('./config');
require('./db'); // 初始化 schema 与种子
const { errorHandler } = require('./util');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// 安全头（同源部署，无需放开 CORS）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// 简易请求日志（结构化 JSON，不记录敏感字段）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(JSON.stringify({ level: 'info', method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start }));
    }
  });
  next();
});

// 健康检查
app.get('/health', (req, res) => res.json({ status: 'ok' }));
// 版本探针：确认线上进程已加载最新代码（每次发布递增）
const BUILD_VERSION = '2026-11-03.1-unified-accounts';
app.get('/api/version', (req, res) => res.json({ version: BUILD_VERSION }));
app.get('/ready', (req, res) => {
  try {
    require('./db').prepare('SELECT 1').get();
    res.json({ status: 'ready' });
  } catch (e) {
    res.status(503).json({ status: 'not_ready' });
  }
});

// API 路由
app.use('/api/auth', require('./routes/auth'));
// 泽曦工作台统一账号同步（Bearer 密钥，仅 zexi-api 调用；需在超管页配置 ZC_SYNC_KEY）
app.use('/api/internal', require('./routes/internal'));
app.use('/api/dicts', require('./routes/dicts'));
app.use('/api/assets', require('./routes/assets'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/usages', require('./routes/usages'));
app.use('/api/changes', require('./routes/changes'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/dashboard', require('./routes/dashboard'));

// 上传文件与前端静态资源
// 注意：<img src> 无法携带鉴权头，上传文件采用「不可枚举文件名（时间戳+随机字节）」保护，公开读取
app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use(errorHandler);

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: `资产管理系统已启动，监听 0.0.0.0:${config.port}` }));
});

// 优雅停机
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(JSON.stringify({ level: 'info', msg: `收到 ${sig}，正在优雅停机...` }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
