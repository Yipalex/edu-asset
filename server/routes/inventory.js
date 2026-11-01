// 盘点任务：发起（自动生成明细）→ 逐件核对（拍照）→ 完成 → 差异处理
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, hasRole } = require('../middleware/auth');
const { requireFields, notFound, conflict, forbidden, badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const sql = `
    SELECT t.*, c.name AS campus_name, u.name AS created_by_name,
      (SELECT COUNT(*) FROM inventory_items i WHERE i.task_id=t.id) AS total,
      (SELECT COUNT(*) FROM inventory_items i WHERE i.task_id=t.id AND i.result IS NOT NULL) AS checked,
      (SELECT COUNT(*) FROM inventory_items i WHERE i.task_id=t.id AND i.result IS NOT NULL AND i.result != '一致') AS diff
    FROM inventory_tasks t
    JOIN campuses c ON c.id=t.campus_id
    LEFT JOIN users u ON u.id=t.created_by`;
  const rows = hasRole(req.user, 'admin', 'finance', 'principal')
    ? db.prepare(`${sql} ORDER BY t.id DESC`).all()
    : db.prepare(`${sql} WHERE t.campus_id=? ORDER BY t.id DESC`).all(req.user.campus_id);
  res.json(rows);
});

router.get('/:id(\\d+)', (req, res, next) => {
  try {
    const t = db.prepare(`SELECT t.*, c.name AS campus_name FROM inventory_tasks t JOIN campuses c ON c.id=t.campus_id WHERE t.id=?`).get(req.params.id);
    if (!t) throw notFound('盘点任务不存在');
    if (!hasRole(req.user, 'admin', 'finance', 'principal') && t.campus_id !== req.user.campus_id) throw forbidden('无权查看其他校区盘点任务');
    const items = db.prepare(`
      SELECT i.*, a.asset_no, a.name AS asset_name, a.status AS asset_status, a.photos AS asset_photos,
             l.name AS location_name, u.name AS user_name, ck.name AS checked_by_name
      FROM inventory_items i
      JOIN assets a ON a.id=i.asset_id
      LEFT JOIN locations l ON l.id=a.location_id
      LEFT JOIN users u ON u.id=a.user_id
      LEFT JOIN users ck ON ck.id=i.checked_by
      WHERE i.task_id=? ORDER BY i.id`).all(t.id)
      .map((i) => ({ ...i, photos: JSON.parse(i.photos || '[]'), asset_photos: JSON.parse(i.asset_photos || '[]') }));
    res.json({ ...t, items });
  } catch (e) { next(e); }
});

// 发起盘点任务（行政 / 本校区负责人）：自动生成该校区未报废资产明细
router.post('/', requireRole('admin', 'head'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'campus_id']);
    if (req.user.role === 'head' && req.body.campus_id !== req.user.campus_id) throw forbidden('只能发起本校区盘点');
    const campus = db.prepare('SELECT * FROM campuses WHERE id=?').get(req.body.campus_id);
    if (!campus) throw notFound('校区不存在');
    const assets = db.prepare(`SELECT id FROM assets WHERE campus_id=? AND status != '已报废'`).all(campus.id);
    if (assets.length === 0) throw badRequest('该校区暂无在账资产');
    const tx = db.transaction(() => {
      const r = db.prepare('INSERT INTO inventory_tasks (name, campus_id, deadline, created_by) VALUES (?,?,?,?)')
        .run(req.body.name, campus.id, req.body.deadline || null, req.user.id);
      const taskId = r.lastInsertRowid;
      const ins = db.prepare('INSERT INTO inventory_items (task_id, asset_id) VALUES (?,?)');
      for (const a of assets) ins.run(taskId, a.id);
      return taskId;
    });
    const taskId = tx();
    res.status(201).json({ id: taskId, total: assets.length });
  } catch (e) { next(e); }
});

// 盘点明细核对（拍照上传结果）— 行政/本校区负责人/参与教师
router.post('/items/:itemId(\\d+)/check', requireRole('admin', 'head', 'teacher'), (req, res, next) => {
  try {
    requireFields(req.body, ['result']);
    if (!['一致', '盘亏', '信息不符'].includes(req.body.result)) throw badRequest('盘点结果不合法');
    const item = db.prepare(`SELECT i.*, t.campus_id, t.status AS task_status FROM inventory_items i JOIN inventory_tasks t ON t.id=i.task_id WHERE i.id=?`).get(req.params.itemId);
    if (!item) throw notFound('盘点明细不存在');
    if (item.task_status !== '进行中') throw conflict('盘点任务已结束');
    if (!hasRole(req.user, 'admin') && item.campus_id !== req.user.campus_id) throw forbidden('只能盘点本校区资产');
    db.prepare(`UPDATE inventory_items SET result=?, in_book=?, photos=?, checked_by=?, checked_at=datetime('now','localtime') WHERE id=?`)
      .run(req.body.result, req.body.in_book || '在账', JSON.stringify(req.body.photos || []), req.user.id, item.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 完成盘点（行政/本校区负责人）：要求全部核对
router.post('/:id(\\d+)/finish', requireRole('admin', 'head'), (req, res, next) => {
  try {
    const t = db.prepare('SELECT * FROM inventory_tasks WHERE id=?').get(req.params.id);
    if (!t) throw notFound('盘点任务不存在');
    if (t.status !== '进行中') throw conflict('任务已完成');
    if (req.user.role === 'head' && t.campus_id !== req.user.campus_id) throw forbidden('只能完成本校区盘点');
    const unchecked = db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE task_id=? AND result IS NULL').get(t.id).c;
    if (unchecked > 0) throw conflict(`还有 ${unchecked} 件资产未核对`);
    const diff = db.prepare(`SELECT COUNT(*) c FROM inventory_items WHERE task_id=? AND result != '一致'`).get(t.id).c;
    db.prepare(`UPDATE inventory_tasks SET status='已完成', finished_at=datetime('now','localtime') WHERE id=?`).run(t.id);
    res.json({ ok: true, diff });
  } catch (e) { next(e); }
});

module.exports = router;
