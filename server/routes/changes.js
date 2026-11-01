// 资产变动单：调拨（校区内/跨校区分流）/ 维修 / 报废（财务审核）
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, hasRole } = require('../middleware/auth');
const { requireFields, notFound, conflict, forbidden, nextOrderNo, badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

function recordApproval(orderId, step, user, action, comment) {
  db.prepare('INSERT INTO approvals (order_type, order_id, step, approver_id, action, comment) VALUES (?,?,?,?,?,?)')
    .run('change', orderId, step, user.id, action, comment || null);
}

// 计算审批链第一步
function firstStep(type, fromCampusId, toCampusId) {
  if (type === '调拨') return fromCampusId === toCampusId ? 'head_from' : 'head_from';
  if (type === '报废') return 'head_from';
  return 'head_from'; // 维修
}

router.get('/', (req, res) => {
  const sql = `
    SELECT co.*, a.asset_no, a.name AS asset_name, fc.name AS from_campus_name, tc.name AS to_campus_name,
           r.name AS receiver_name, cb.name AS created_by_name
    FROM change_orders co
    JOIN assets a ON a.id=co.asset_id
    JOIN campuses fc ON fc.id=co.from_campus_id
    LEFT JOIN campuses tc ON tc.id=co.to_campus_id
    LEFT JOIN users r ON r.id=co.receiver_id
    LEFT JOIN users cb ON cb.id=co.created_by`;
  let rows;
  if (hasRole(req.user, 'admin', 'finance', 'principal')) {
    rows = db.prepare(`${sql} ORDER BY co.id DESC`).all();
  } else if (req.user.role === 'head') {
    rows = db.prepare(`${sql} WHERE co.from_campus_id=? OR co.to_campus_id=? ORDER BY co.id DESC`).all(req.user.campus_id, req.user.campus_id);
  } else {
    rows = db.prepare(`${sql} WHERE co.created_by=? ORDER BY co.id DESC`).all(req.user.id);
  }
  res.json(rows);
});

router.get('/:id(\\d+)', (req, res, next) => {
  try {
    const o = db.prepare(`
      SELECT co.*, a.asset_no, a.name AS asset_name, a.photos AS asset_photos, fc.name AS from_campus_name, tc.name AS to_campus_name,
             r.name AS receiver_name, tl.name AS to_location_name
      FROM change_orders co
      JOIN assets a ON a.id=co.asset_id
      JOIN campuses fc ON fc.id=co.from_campus_id
      LEFT JOIN campuses tc ON tc.id=co.to_campus_id
      LEFT JOIN users r ON r.id=co.receiver_id
      LEFT JOIN locations tl ON tl.id=co.to_location_id
      WHERE co.id=?`).get(req.params.id);
    if (!o) throw notFound('单据不存在');
    const approvals = db.prepare(`SELECT ap.*, u.name AS approver_name FROM approvals ap JOIN users u ON u.id=ap.approver_id WHERE ap.order_type='change' AND ap.order_id=? ORDER BY ap.id`).all(o.id);
    res.json({ ...o, asset_photos: JSON.parse(o.asset_photos || '[]'), approvals });
  } catch (e) { next(e); }
});

// 发起变动单
router.post('/', requireRole('admin', 'head', 'teacher'), (req, res, next) => {
  try {
    requireFields(req.body, ['asset_id', 'type']);
    const { asset_id, type } = req.body;
    if (!['调拨', '维修', '报废'].includes(type)) throw badRequest('变动类型不合法');
    const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(asset_id);
    if (!asset) throw notFound('资产不存在');
    if (asset.status === '已报废') throw conflict('资产已报废，无法再发起变动');
    if (!hasRole(req.user, 'admin') && asset.campus_id !== req.user.campus_id) throw forbidden('只能对本校区资产发起变动');
    if (req.user.role === 'teacher' && type === '调拨') throw forbidden('教师不可发起调拨');

    let toCampusId = null;
    if (type === '调拨') {
      requireFields(req.body, ['to_campus_id']);
      toCampusId = req.body.to_campus_id;
      if (!db.prepare('SELECT id FROM campuses WHERE id=? AND status=\'启用\'').get(toCampusId)) throw badRequest('目标校区不存在或已停用');
    }
    const orderNo = nextOrderNo('BD', 'change_orders');
    const r = db.prepare(`INSERT INTO change_orders (order_no, asset_id, type, from_campus_id, to_campus_id, to_location_id, receiver_id, fee, reason, current_step, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(orderNo, asset_id, type, asset.campus_id, toCampusId,
      req.body.to_location_id || null, req.body.receiver_id || null, Number(req.body.fee || 0),
      req.body.reason || null, firstStep(type, asset.campus_id, toCampusId), req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, order_no: orderNo });
  } catch (e) { next(e); }
});

// 审批（按 current_step 流转）
router.post('/:id(\\d+)/approve', (req, res, next) => {
  try {
    requireFields(req.body, ['action']);
    if (!['通过', '拒绝'].includes(req.body.action)) throw badRequest('操作不合法');
    const o = db.prepare('SELECT * FROM change_orders WHERE id=?').get(req.params.id);
    if (!o) throw notFound('单据不存在');
    if (o.status !== '待审批') throw conflict(`当前状态为「${o.status}」`);

    const step = o.current_step;
    const user = req.user;
    // 校验当前人是否有权审批这一步
    if (step === 'head_from') {
      if (!(hasRole(user, 'admin') || (user.role === 'head' && user.campus_id === o.from_campus_id))) throw forbidden('需要调出校区负责人审批');
    } else if (step === 'head_to') {
      if (!(hasRole(user, 'admin') || (user.role === 'head' && user.campus_id === o.to_campus_id))) throw forbidden('需要调入校区负责人审批');
    } else if (step === 'finance') {
      if (!hasRole(user, 'finance')) throw forbidden('需要财务审核');
    } else if (step === 'admin_exec') {
      if (!hasRole(user, 'admin')) throw forbidden('需要行政后勤执行');
    } else {
      throw conflict('流程已结束');
    }

    if (req.body.action === '拒绝') {
      db.prepare(`UPDATE change_orders SET status='已拒绝', current_step='done' WHERE id=?`).run(o.id);
      recordApproval(o.id, step, user, '拒绝', req.body.comment);
      return res.json({ ok: true, status: '已拒绝' });
    }

    recordApproval(o.id, step, user, '通过', req.body.comment);

    // 流转下一步
    let nextStep;
    if (o.type === '调拨') {
      const cross = o.from_campus_id !== o.to_campus_id;
      if (step === 'head_from') nextStep = cross ? 'head_to' : 'admin_exec';
      else if (step === 'head_to') nextStep = 'admin_exec';
      else nextStep = 'done';
    } else if (o.type === '报废') {
      if (step === 'head_from') nextStep = 'finance';
      else if (step === 'finance') nextStep = 'admin_exec';
      else nextStep = 'done';
    } else { // 维修
      if (step === 'head_from') nextStep = 'admin_exec';
      else nextStep = 'done';
    }

    if (nextStep !== 'done') {
      db.prepare('UPDATE change_orders SET current_step=? WHERE id=?').run(nextStep, o.id);
      return res.json({ ok: true, current_step: nextStep });
    }

    // 行政执行完成 → 回写台账（事务）
    const tx = db.transaction(() => {
      db.prepare(`UPDATE change_orders SET status='已完成', current_step='done' WHERE id=?`).run(o.id);
      if (o.type === '报废') {
        db.prepare(`UPDATE assets SET status='已报废', user_id=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(o.asset_id);
      } else if (o.type === '维修') {
        db.prepare(`UPDATE assets SET status='维修中', updated_at=datetime('now','localtime') WHERE id=?`).run(o.asset_id);
      } else if (o.type === '调拨') {
        db.prepare(`UPDATE assets SET campus_id=?, location_id=?, user_id=?, updated_at=datetime('now','localtime') WHERE id=?`)
          .run(o.to_campus_id, o.to_location_id, o.receiver_id, o.asset_id);
      }
    });
    tx();
    res.json({ ok: true, status: '已完成' });
  } catch (e) { next(e); }
});

// 维修完成：恢复在用（行政）
router.post('/:id(\\d+)/repair-done', requireRole('admin'), (req, res, next) => {
  try {
    const o = db.prepare(`SELECT * FROM change_orders WHERE id=? AND type='维修' AND status='已完成'`).get(req.params.id);
    if (!o) throw notFound('维修单不存在或未完成');
    db.prepare(`UPDATE assets SET status='在用', updated_at=datetime('now','localtime') WHERE id=? AND status='维修中'`).run(o.asset_id);
    recordApproval(o.id, 'repair_done', req.user, '维修完成', req.body.comment);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
