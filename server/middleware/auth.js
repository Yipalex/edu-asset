// 认证与授权中间件
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { unauthorized, forbidden } = require('../util');

function signAccess(user) {
  return jwt.sign({ uid: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.accessTtl });
}

function issueRefresh(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + config.refreshTtlDays * 86400 * 1000);
  db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)')
    .run(userId, tokenHash, expires.toISOString());
  return token;
}

function verifyRefresh(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=?').get(tokenHash);
  if (!row) throw unauthorized('刷新令牌无效');
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM refresh_tokens WHERE id=?').run(row.id);
    throw unauthorized('登录已过期，请重新登录');
  }
  return row;
}

function revokeRefresh(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM refresh_tokens WHERE token_hash=?').run(tokenHash);
}

// 解析并加载当前用户
// 令牌来源优先级：HttpOnly Cookie（主，网关不会剥离标准 Cookie 头）> Authorization 头 > X-Auth-Token 头
function parseCookies(req) {
  const raw = req.headers.cookie;
  const out = {};
  if (typeof raw === 'string') {
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function extractToken(req) {
  // 1) HttpOnly Cookie（浏览器自动携带，穿透反向代理）
  const cookies = parseCookies(req);
  const cookieToken = cookies[config.cookieName];
  if (cookieToken) return cookieToken;
  // 2) 标准 Authorization 头
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/i);
  if (m) return m[1].trim();
  // 3) 自定义头兜底
  const custom = req.headers['x-auth-token'];
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  if (Array.isArray(custom) && custom.length) return String(custom[0]).trim();
  return null;
}

// 设置 HttpOnly 会话 Cookie
function setAuthCookie(res, token, maxAgeMs) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  res.append('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  res.append('Set-Cookie', `${config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next(unauthorized());
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (e) {
    return next(unauthorized());
  }
  const user = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.campus_id, u.department, u.is_active, c.name AS campus_name, c.code AS campus_code
    FROM users u LEFT JOIN campuses c ON c.id=u.campus_id WHERE u.id=?`).get(payload.uid);
  if (!user || !user.is_active) return next(unauthorized('账号不存在或已停用'));
  req.user = user;
  next();
}

// 角色判定：superadmin（超级管理员）继承全部全局管理权限（admin/finance/principal 视角）
// 这样各业务路由无需逐个列举 superadmin，权限模型集中在此处
function effectiveRoles(role) {
  if (role === 'superadmin') return ['superadmin', 'admin', 'finance', 'principal'];
  return [role];
}

function hasRole(user, ...roles) {
  const eff = effectiveRoles(user.role);
  return roles.some((r) => eff.includes(r));
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!hasRole(req.user, ...roles)) return next(forbidden());
    next();
  };
}

// 校区可见范围：全局角色看全部；head/teacher 限本校区
function campusScope(user, column = 'campus_id') {
  if (hasRole(user, 'admin', 'finance', 'principal')) return { where: '1=1', params: [] };
  return { where: `${column} = ?`, params: [user.campus_id] };
}

// 校验目标校区是否在当前用户可操作范围
function assertCampusAccess(user, campusId) {
  if (hasRole(user, 'admin', 'finance', 'principal')) return;
  if (user.campus_id !== campusId) throw forbidden('只能操作本校区数据');
}

module.exports = {
  signAccess, issueRefresh, verifyRefresh, revokeRefresh,
  requireAuth, requireRole, hasRole, effectiveRoles, campusScope, assertCampusAccess,
  setAuthCookie, clearAuthCookie,
};
