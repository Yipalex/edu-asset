// 内部账号同步接口：仅供泽曦工作台统一后端（zexi-api）调用
// 认证：Authorization: Bearer <ZC_SYNC_KEY>（配置在 .env，不进代码库）
// 作用：统一账号体系下，向本系统开通/停用「影子账号」——
//   username = 手机号；bcrypt 哈希由各系统共用算法生成，原样写入即可同密码登录；
//   已存在的老账号（含历史非手机号用户名）不受影响，仅按 username=手机号 接管。
const express = require('express');
const db = require('../db');
const config = require('../config');
const { badRequest, unauthorized } = require('../util');

const router = express.Router();

const VALID_ROLES = ['superadmin', 'admin', 'head', 'teacher', 'finance', 'principal'];

// 密钥校验（每个请求都查最新配置，便于轮换 .env 后无需重启）
function requireSyncKey(req) {
  if (!config.syncKey) {
    const e = new Error('ZC_SYNC_KEY 未配置');
    e.status = 500;
    throw e;
  }
  const h = req.headers.authorization || '';
  if (h !== 'Bearer ' + config.syncKey) throw unauthorized('同步密钥无效');
}

router.post('/account-sync', (req, res, next) => {
  try {
    requireSyncKey(req);
    const { action, phone, name, password_hash, role, active } = req.body || {};

    if (action === 'upsert') {
      if (!/^1\d{10}$/.test(String(phone || ''))) throw badRequest('手机号格式不正确');
      if (typeof name !== 'string' || !name.trim()) throw badRequest('请填写姓名');
      if (!VALID_ROLES.includes(role)) throw badRequest('无效的角色: ' + role);
      if (typeof password_hash !== 'string' || !password_hash.startsWith('$2')) throw badRequest('密码哈希格式不正确');
      const isActive = active === false ? 0 : 1;
      const exist = db.prepare('SELECT id FROM users WHERE username = ?').get(String(phone));
      if (exist) {
        db.prepare('UPDATE users SET password_hash = ?, name = ?, role = ?, is_active = ? WHERE id = ?')
          .run(password_hash, name.trim(), role, isActive, exist.id);
      } else {
        db.prepare('INSERT INTO users (username, password_hash, name, role, is_active) VALUES (?,?,?,?,?)')
          .run(String(phone), password_hash, name.trim(), role, isActive);
      }
      return res.json({ ok: true, action: 'upsert', phone: String(phone) });
    }

    if (action === 'set-active') {
      if (!/^1\d{10}$/.test(String(phone || ''))) throw badRequest('手机号格式不正确');
      const isActive = active === false ? 0 : 1;
      const r = db.prepare('UPDATE users SET is_active = ? WHERE username = ?').run(isActive, String(phone));
      return res.json({ ok: true, action: 'set-active', phone: String(phone), matched: r.changes > 0 });
    }

    throw badRequest('未知 action: ' + action);
  } catch (e) { next(e); }
});

module.exports = router;
