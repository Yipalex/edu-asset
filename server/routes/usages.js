// 领用借用单：申请 → 校区负责人审批 → 行政执行(回写台账) → 归还(回写台账)
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, hasRole } = require('../middleware/auth');
const { requireFields, notFound, conflict, forbidden, nextOrderNo } = require('../util');

const router = express.Router();
router.use(requireAuth);

function view(o) {
  return db.prepare(`
    SELECT uo.*, a.asset_no, a.name AS asset_name, a.photos AS asset_photos, c.name AS campus_name,
           u.name AS user_name, cb.name AS created_by_name
    FROM usage_orders uo
    JOIN assets a ON a.id=uo.asset_id
    JOIN campuses c ON c.id=uo.campus_id
    JOIN users u ON u.id=uo.user_id
    LEFT JOIN users cb ON cb.id=uo.created_by
    WHERE uo.id=?`).get(o.id ?? o);
}

function recordApproval(orderId, step, user, action, comment) {
  db.prepare('INSERT INTO approvals (order_type, order_id, step, approver_id, action, comment) VALUES (?,?,?,?,?,?)')
    .run('usage', orderId, step, user.id, action, comment || null);
}

// 列表：教师看本人申请；负责人看本校区；行政/财务/校长看全部
router.get('/', (req, res) => {
  let rows;
  if (req.user.role === 'teacher') {
    rows = db.prepare(`SELECT uo.*, a.asset_no, a.name AS asset_name, c.name AS campus_name, u.name AS user_name
      FROM usage_orders uo JOIN assets a ON a.id=uo.asset_id JOIN campuses c ON c.id=uo.campus_id JOIN users u ON u.id=uo.user_id
      WHERE uo.created_by=? OR uo.user_id=? ORDER BY uo.id DESC`).all(req.user.id, req.user.id);
  } else if (hasRole(req.user, 'admin', 'finance', 'principal')) {
    rows = db.prepare(`SELECT uo.*, a.asset_no, a.name AS asset_name, c.name AS campus_name, u.name AS user_name
      FROM usage_orders uo JOIN assets a ON a.id=uo.asset_id JOIN campuses c ON c.id=uo.campus_id JOIN users u ON u.id=uo.user_id ORDER BY uo.id DESC`).all();
  } else {
    rows = db.prepare(`SELECT uo.*, a.asset_no, a.name AS asset_name, c.name AS campus_name, u.name AS user_name
      FROM usage_orders uo JOIN assets a ON a.id=uo.asset_id JOIN campuses c ON c.id=uo.campus_id JOIN users u ON u.id=uo.user_id
      WHERE uo.campus_id=? ORDER BY uo.id DESC`).all(req.user.campus_id);
  }
  res.json(rows);
});

router.get('/:id(\\d+)', (req, res, next) => {
  try {
    const o = view(req.params.id);
    if (!o) throw notFound('单据不存在');
    const approvals = db.prepare(`SELECT ap.*, u.name AS approver_name FROM approvals ap JOIN users u ON u.id=ap.approver_id WHERE ap.order_type='usage' AND ap.order_id=? ORDER BY ap.id`).all(o.id);
    res.json({ ...o, asset_photos: JSON.parse(o.asset_photos || '[]'), approvals });
  } catch (e) { next(e); }
});

// 提交申请（教师/行政/负责人均可；教师只能为自己申请本校区资产）
router.post('/', requireRole('admin', 'head', 'teacher'), (req, res, next) => {
  try {
    requireFields(req.body, ['asset_id', 'type']);
    if (!['领用', '借用'].includes(req.body.type)) throw conflict('类型不合法');
    const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(req.body.asset_id);
    if (!asset) throw notFound('资产不存在');
    if (!['在用', '闲置'].includes(asset.status)) throw conflict(`资产当前状态为「${asset.status}」，不可申请`);
    if (!hasRole(req.user, 'admin') && asset.campus_id !== req.user.campus_id) throw forbidden('只能申请本校区资产');
    const targetUserId = req.body.user_id || req.user.id;
    const orderNo = nextOrderNo('LY', 'usage_orders');
    const r = db.prepare(`INSERT INTO usage_orders (order_no, campus_id, asset_id, user_id, type, expected_return, reason, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(orderNo, asset.campus_id, asset.id, targetUserId, req.body.type,
      req.body.expected_return || null, req.body.reason || null, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, order_no: orderNo });
  } catch (e) { next(e); }
});

// 审批（校区负责人 或 行政）
router.post('/:id(\\d+)/approve', requireRole('admin', 'head'), (req, res, next) => {
  try {
    requireFields(req.body, ['action']);
    if (!['通过', '拒绝'].includes(req.body.action)) throw conflict('操作不合法');
    const o = db.prepare('SELECT * FROM usage_orders WHERE id=?').get(req.params.id);
    if (!o) throw notFound('单据不存在');
    if (o.status !== '待审批') throw conflict(`当前状态为「${o.status}」，无法审批`);
    if (req.user.role === 'head' && o.campus_id !== req.user.campus_id) throw forbidden('只能审批本校区单据');
    const newStatus = req.body.action === '通过' ? '已批准' : '已拒绝';
    db.prepare('UPDATE usage_orders SET status=? WHERE id=?').run(newStatus, o.id);
    recordApproval(o.id, '校区负责人审批', req.user, req.body.action, req.body.comment);
    res.json({ ok: true, status: newStatus });
  } catch (e) { next(e); }
});

// 行政执行：回写台账使用人与状态（事务）
router.post('/:id(\\d+)/execute', requireRole('admin'), (req, res, next) => {
  try {
    const o = db.prepare('SELECT * FROM usage_orders WHERE id=?').get(req.params.id);
    if (!o) throw notFound('单据不存在');
    if (o.status !== '已批准') throw conflict(`当前状态为「${o.status}」，仅已批准可执行`);
    const tx = db.transaction(() => {
      db.prepare('UPDATE usage_orders SET status=? WHERE id=?').run('已执行', o.id);
      db.prepare(`UPDATE assets SET user_id=?, status=?, updated_at=datetime('now','localtime') WHERE id=?`)
        .run(o.user_id, o.type === '借用' ? '借用中' : '在用', o.asset_id);
      recordApproval(o.id, '行政执行', req.user, '执行', req.body.comment);
    });
    tx();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 归还：释放资产
router.post('/:id(\\d+)/return', requireRole('admin', 'head', 'teacher'), (req, res, next) => {
  try {
    const o = db.prepare('SELECT * FROM usage_orders WHERE id=?').get(req.params.id);
    if (!o) throw notFound('单据不存在');
    if (o.status !== '已执行') throw conflict(`当前状态为「${o.status}」，无法归还`);
    if (req.user.role === 'teacher' && o.user_id !== req.user.id && o.created_by !== req.user.id) throw forbidden('只能归还本人单据');
    if (req.user.role === 'head' && o.campus_id !== req.user.campus_id) throw forbidden('只能操作本校区单据');
    const tx = db.transaction(() => {
      db.prepare('UPDATE usage_orders SET status=? WHERE id=?').run('已归还', o.id);
      db.prepare(`UPDATE assets SET user_id=NULL, status='闲置', updated_at=datetime('now','localtime') WHERE id=?`).run(o.asset_id);
      recordApproval(o.id, '归还', req.user, '归还', req.body.comment);
    });
    tx();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
