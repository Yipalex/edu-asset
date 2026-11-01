// 认证路由：登录 / 刷新 / 登出 / 当前用户
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { signAccess, issueRefresh, verifyRefresh, revokeRefresh, requireAuth, setAuthCookie, clearAuthCookie } = require('../middleware/auth');
const { badRequest, unauthorized, requireFields } = require('../util');

const router = express.Router();

// Cookie 有效期与访问令牌一致
const COOKIE_MAX_AGE = (() => {
  const m = String(config.accessTtl).match(/^(\d+)([smhd])$/);
  if (!m) return 2 * 3600 * 1000;
  const n = parseInt(m[1], 10);
  return n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
})();

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, campus_id: u.campus_id, campus_name: u.campus_name, department: u.department };
}

router.post('/login', (req, res, next) => {
  try {
    requireFields(req.body, ['username', 'password']);
    const u = db.prepare(`
      SELECT u.*, c.name AS campus_name FROM users u LEFT JOIN campuses c ON c.id=u.campus_id
      WHERE u.username=?`).get(req.body.username);
    if (!u || !u.is_active || !bcrypt.compareSync(req.body.password, u.password_hash)) {
      throw unauthorized('用户名或密码错误');
    }
    const accessToken = signAccess(u);
    setAuthCookie(res, accessToken, COOKIE_MAX_AGE);
    res.json({ accessToken, refreshToken: issueRefresh(u.id), user: publicUser(u) });
  } catch (e) { next(e); }
});

router.post('/refresh', (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) throw badRequest('缺少 refreshToken');
    const row = verifyRefresh(refreshToken);
    const u = db.prepare('SELECT u.*, c.name AS campus_name FROM users u LEFT JOIN campuses c ON c.id=u.campus_id WHERE u.id=?').get(row.user_id);
    if (!u || !u.is_active) throw unauthorized();
    revokeRefresh(refreshToken); // 旋转刷新令牌
    const accessToken = signAccess(u);
    setAuthCookie(res, accessToken, COOKIE_MAX_AGE);
    res.json({ accessToken, refreshToken: issueRefresh(u.id), user: publicUser(u) });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) revokeRefresh(refreshToken);
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// 修改本人密码（所有角色可用；成功后清除本人全部刷新令牌，其他设备需重新登录）
router.post('/change-password', requireAuth, (req, res, next) => {
  try {
    requireFields(req.body, ['oldPassword', 'newPassword']);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!u || !bcrypt.compareSync(req.body.oldPassword, u.password_hash)) throw badRequest('原密码不正确');
    const np = String(req.body.newPassword);
    if (np.length < 6) throw badRequest('新密码至少 6 位');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(np, 10), u.id);
    db.prepare('DELETE FROM refresh_tokens WHERE user_id=?').run(u.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
