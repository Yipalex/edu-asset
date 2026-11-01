// 类型化错误 + 工具函数
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const badRequest = (msg) => new AppError(400, 'BAD_REQUEST', msg);
const unauthorized = (msg = '未登录或登录已过期') => new AppError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = '没有权限执行此操作') => new AppError(403, 'FORBIDDEN', msg);
const notFound = (msg = '资源不存在') => new AppError(404, 'NOT_FOUND', msg);
const conflict = (msg) => new AppError(409, 'CONFLICT', msg);

// 全局错误处理中间件
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' } });
  }
  console.error(JSON.stringify({ level: 'error', msg: err.message, stack: process.env.NODE_ENV === 'production' ? undefined : err.stack, path: req.path }));
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
}

// 校验辅助
function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') throw badRequest(`缺少必填字段: ${f}`);
  }
}

// 单号生成
const db = require('./db');
function nextOrderNo(prefix, table) {
  const y = new Date().getFullYear();
  const row = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE order_no LIKE ?`).get(`${prefix}${y}-%`);
  return `${prefix}${y}-${String(row.c + 1).padStart(4, '0')}`;
}

// 资产编号：校区简码-分类编码-年份-流水号
function nextAssetNo(campusCode, catCode) {
  const y = new Date().getFullYear();
  const prefix = `${campusCode}-${catCode}-${y}-`;
  const row = db.prepare('SELECT COUNT(*) c FROM assets WHERE asset_no LIKE ?').get(`${prefix}%`);
  return `${prefix}${String(row.c + 1).padStart(4, '0')}`;
}

// 当前月 / 下月（YYYY-MM，本地时区）——折旧「当月录入不算，次月开始算」
function curMonthYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nextMonthYm() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// 两个 YYYY-MM 之间相差的整月数（a<=b）
function monthDiff(a, b) {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

// 资产组编号：G校区简码-分类编码-年月-流水号（期初建档同批多件共用）
function nextGroupNo(campusCode, catCode, seq) {
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `G${campusCode}-${catCode}-${ym}-${String(seq).padStart(3, '0')}`;
}

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, errorHandler, requireFields, nextOrderNo, nextAssetNo, curMonthYm, nextMonthYm, monthDiff, nextGroupNo };
