// 基础数据：校区 / 分类 / 存放地点 / 用户（行政维护）
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole, hasRole } = require('../middleware/auth');
const { requireFields, notFound, conflict, badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

// ---------- 校区 ----------
router.get('/campuses', (req, res) => {
  res.json(db.prepare(`SELECT c.*, u.name AS head_name FROM campuses c LEFT JOIN users u ON u.id=c.head_user_id ORDER BY c.id`).all());
});
router.post('/campuses', requireRole('admin'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'code']);
    const { name, code, head_user_id } = req.body;
    const dup = db.prepare('SELECT id FROM campuses WHERE code=?').get(code);
    if (dup) throw conflict('校区简码已存在');
    const r = db.prepare('INSERT INTO campuses (name, code, head_user_id) VALUES (?,?,?)').run(name, code.toUpperCase(), head_user_id || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { next(e); }
});
router.put('/campuses/:id', requireRole('admin'), (req, res, next) => {
  try {
    const c = db.prepare('SELECT * FROM campuses WHERE id=?').get(req.params.id);
    if (!c) throw notFound('校区不存在');
    db.prepare('UPDATE campuses SET name=?, head_user_id=?, status=? WHERE id=?')
      .run(req.body.name ?? c.name, req.body.head_user_id ?? c.head_user_id, req.body.status ?? c.status, c.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 资产分类 ----------
router.get('/categories', (req, res) => {
  res.json(db.prepare("SELECT * FROM categories WHERE status='启用' ORDER BY code").all());
});
router.post('/categories', requireRole('admin'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'code']);
    if (db.prepare('SELECT id FROM categories WHERE code=?').get(req.body.code)) throw conflict('分类编码已存在');
    const r = db.prepare('INSERT INTO categories (name, code, life_years, salvage_rate) VALUES (?,?,?,?)')
      .run(req.body.name, req.body.code, parseInt(req.body.life_years || '5', 10),
        req.body.salvage_rate != null ? Number(req.body.salvage_rate) : 0.05);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { next(e); }
});
router.put('/categories/:id', requireRole('admin'), (req, res, next) => {
  try {
    const c = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
    if (!c) throw notFound('分类不存在');
    db.prepare('UPDATE categories SET name=?, life_years=?, salvage_rate=?, status=? WHERE id=?')
      .run(req.body.name ?? c.name, req.body.life_years ?? c.life_years,
        req.body.salvage_rate != null ? Number(req.body.salvage_rate) : c.salvage_rate, req.body.status ?? c.status, c.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 存放地点 ----------
router.get('/locations', (req, res) => {
  const rows = hasRole(req.user, 'admin')
    ? db.prepare(`SELECT l.*, c.name AS campus_name FROM locations l JOIN campuses c ON c.id=l.campus_id ORDER BY l.id`).all()
    : db.prepare(`SELECT l.*, c.name AS campus_name FROM locations l JOIN campuses c ON c.id=l.campus_id WHERE l.campus_id=? ORDER BY l.id`).all(req.user.campus_id);
  res.json(rows);
});
router.post('/locations', requireRole('admin'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'campus_id']);
    const r = db.prepare('INSERT INTO locations (name, campus_id, department) VALUES (?,?,?)')
      .run(req.body.name, req.body.campus_id, req.body.department || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { next(e); }
});
router.put('/locations/:id', requireRole('admin'), (req, res, next) => {
  try {
    const l = db.prepare('SELECT * FROM locations WHERE id=?').get(req.params.id);
    if (!l) throw notFound('地点不存在');
    db.prepare('UPDATE locations SET name=?, department=?, status=? WHERE id=?')
      .run(req.body.name ?? l.name, req.body.department ?? l.department, req.body.status ?? l.status, l.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 用户（超级管理员独享管理权：开通账号、分配角色/校区、启用停用、重置密码） ----------
router.get('/users', requireRole('superadmin', 'admin', 'finance', 'principal'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.campus_id, u.department, u.is_active, c.name AS campus_name
    FROM users u LEFT JOIN campuses c ON c.id=u.campus_id ORDER BY u.id`).all());
});
router.post('/users', requireRole('superadmin'), (req, res, next) => {
  try {
    requireFields(req.body, ['username', 'name', 'role', 'password']);
    if (!['superadmin', 'admin', 'head', 'teacher', 'finance', 'principal'].includes(req.body.role)) throw badRequest('角色不合法');
    if (db.prepare('SELECT id FROM users WHERE username=?').get(req.body.username)) throw conflict('用户名已存在');
    if (String(req.body.password).length < 6) throw badRequest('初始密码至少 6 位');
    const r = db.prepare('INSERT INTO users (username,password_hash,name,role,campus_id,department) VALUES (?,?,?,?,?,?)')
      .run(req.body.username, bcrypt.hashSync(req.body.password, 10), req.body.name, req.body.role, req.body.campus_id || null, req.body.department || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) { next(e); }
});
router.put('/users/:id', requireRole('superadmin'), (req, res, next) => {
  try {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) throw notFound('用户不存在');
    // 保护：不能停用或降级自己，避免超管被锁在门外
    if (u.id === req.user.id) {
      if (req.body.is_active === 0) throw badRequest('不能停用自己的账号');
      if (req.body.role && req.body.role !== 'superadmin') throw badRequest('不能修改自己的角色');
    }
    db.prepare('UPDATE users SET name=?, role=?, campus_id=?, department=?, is_active=? WHERE id=?')
      .run(req.body.name ?? u.name, req.body.role ?? u.role, req.body.campus_id ?? u.campus_id,
        req.body.department ?? u.department, req.body.is_active ?? u.is_active, u.id);
    if (req.body.password) {
      if (String(req.body.password).length < 6) throw badRequest('重置密码至少 6 位');
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), u.id);
      db.prepare('DELETE FROM refresh_tokens WHERE user_id=?').run(u.id); // 重置密码后踢下线
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
