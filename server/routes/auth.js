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
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    campus_id: u.campus_id, campus_name: u.campus_name, department: u.department,
    has_avatar: !!u.avatar_data,
    avatar_url: u.avatar_data ? `/api/auth/avatars/${u.id}?v=${u.avatar_updated_at ? Date.parse(u.avatar_updated_at + 'Z') : 0}` : null,
  };
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

// ---------- 个人资料：头像 / 姓名 / 手机号（2026-11-04） ----------
// 头像以 base64 PNG 存 users.avatar_data；与工作台统一账号体系同步（由 zexi-api 广播）。
// 手机号是本系统登录标识（users.username），修改需校验原密码。

const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

router.get('/avatars/:id', (req, res) => {
  const u = db.prepare('SELECT avatar_data FROM users WHERE id=?').get(Number(req.params.id));
  if (!u || !u.avatar_data) return res.status(404).json({ error: { message: '头像不存在' } });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(Buffer.from(u.avatar_data, 'base64'));
});

// 上传头像：前端已裁剪为正方形 PNG（base64 data URI 或裸 base64）
router.post('/avatar', requireAuth, (req, res, next) => {
  try {
    const raw = String((req.body && req.body.avatar) || '');
    if (!raw) throw badRequest('缺少图片数据');
    const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw badRequest('图片数据格式不正确');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw badRequest('图片内容为空');
    if (buf.length > MAX_AVATAR_BYTES) throw badRequest('图片太大，请选择 3MB 以内的图片');
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') {
      throw badRequest('图片格式无法识别，请重新选择图片');
    }
    db.prepare("UPDATE users SET avatar_data=?, avatar_updated_at=datetime('now') WHERE id=?")
      .run(buf.toString('base64'), req.user.id);
    res.json({ ok: true, avatar_url: `/api/auth/avatars/${req.user.id}?v=${Date.now()}` });
  } catch (e) { next(e); }
});

// 修改姓名 / 手机号
router.post('/profile', requireAuth, (req, res, next) => {
  try {
    const { name, username, oldPassword } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!u) throw unauthorized();

    if (name !== undefined && name !== null) {
      const n = String(name).trim();
      if (!n) throw badRequest('姓名不能为空');
      if (n.length > 30) throw badRequest('姓名最多 30 个字');
      db.prepare('UPDATE users SET name=? WHERE id=?').run(n, u.id);
    }
    if (username !== undefined && username !== null && String(username).trim() !== u.username) {
      const nu = String(username).trim();
      if (!/^1\d{10}$/.test(nu)) throw badRequest('请输入正确的 11 位手机号');
      if (!oldPassword || !bcrypt.compareSync(String(oldPassword), u.password_hash)) {
        throw badRequest('原密码不正确');
      }
      const dup = db.prepare('SELECT id FROM users WHERE username=?').get(nu);
      if (dup) throw badRequest('该手机号已被其他账号使用');
      db.prepare('UPDATE users SET username=? WHERE id=?').run(nu, u.id);
    }
    const fresh = db.prepare('SELECT u.*, c.name AS campus_name FROM users u LEFT JOIN campuses c ON c.id=u.campus_id WHERE u.id=?').get(u.id);
    res.json({ ok: true, user: publicUser(fresh) });
  } catch (e) { next(e); }
});

module.exports = router;