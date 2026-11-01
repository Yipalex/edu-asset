// 仪表盘统计 + 我的待办
const express = require('express');
const db = require('../db');
const { requireAuth, campusScope, hasRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// 看板数据：按当前用户可见校区范围汇总
router.get('/summary', (req, res, next) => {
  try {
    const scope = campusScope(req.user, 'a.campus_id');
    const W = scope.where, P = scope.params;
    const isGlobal = hasRole(req.user, 'admin', 'finance', 'principal');

    const totals = db.prepare(`
      SELECT COUNT(*) AS total,
             ROUND(SUM(a.original_value - a.acc_depreciation), 2) AS net_value,
             SUM(CASE WHEN a.status='在用' OR a.status='借用中' THEN 1 ELSE 0 END) AS in_use,
             SUM(CASE WHEN a.status IN ('维修中') THEN 1 ELSE 0 END) AS repairing
      FROM assets a WHERE ${W} AND a.status != '已报废'`).get(...P);
    const scrap = db.prepare(`SELECT COUNT(*) c FROM assets a WHERE ${W} AND a.status='已报废'`).get(...P).c;

    const byCampus = db.prepare(`
      SELECT c.name, COUNT(a.id) AS count, ROUND(COALESCE(SUM(a.original_value - a.acc_depreciation),0),2) AS net_value
      FROM campuses c LEFT JOIN assets a ON a.campus_id=c.id AND a.status != '已报废'
      ${isGlobal ? '' : 'WHERE c.id = ' + Number(req.user.campus_id)}
      GROUP BY c.id ORDER BY c.id`).all();

    const byStatus = db.prepare(`SELECT a.status, COUNT(*) c FROM assets a WHERE ${W} GROUP BY a.status`).all(...P);
    const byCategory = db.prepare(`
      SELECT cat.name, COUNT(*) c, ROUND(COALESCE(SUM(a.original_value),0),2) AS value
      FROM assets a JOIN categories cat ON cat.id=a.category_id WHERE ${W} GROUP BY cat.id ORDER BY c DESC`).all(...P);

    const poScope = isGlobal
      ? { where: '1=1', params: [] }
      : { where: 'po.campus_id = ?', params: [req.user.campus_id] };
    const monthly = db.prepare(`
      SELECT strftime('%Y-%m', po.arrive_date) AS month, ROUND(SUM(pi.qty * pi.unit_price),2) AS amount
      FROM purchase_orders po JOIN purchase_items pi ON pi.order_id=po.id
      WHERE po.status='验收通过' AND ${poScope.where} AND po.arrive_date >= date('now','-12 months')
      GROUP BY month ORDER BY month`).all(...poScope.params);

    const pendingDisposals = db.prepare(`
      SELECT a.id, a.asset_no, a.name, a.status, a.photos, c.name AS campus_name
      FROM assets a JOIN campuses c ON c.id=a.campus_id
      WHERE ${W} AND a.status IN ('维修中','已报废') ORDER BY a.updated_at DESC LIMIT 20`).all(...P)
      .map((r) => ({ ...r, photos: JSON.parse(r.photos || '[]') }));

    const pivot = db.prepare(`
      SELECT c.name AS campus, a.status, COUNT(*) c
      FROM assets a JOIN campuses c ON c.id=a.campus_id WHERE ${W}
      GROUP BY c.id, a.status`).all(...P);

    const transfers = db.prepare(`
      SELECT co.order_no, a.asset_no, a.name AS asset_name, fc.name AS from_campus, tc.name AS to_campus, co.status, co.created_at
      FROM change_orders co
      JOIN assets a ON a.id=co.asset_id
      JOIN campuses fc ON fc.id=co.from_campus_id
      LEFT JOIN campuses tc ON tc.id=co.to_campus_id
      WHERE co.type='调拨' AND co.from_campus_id != co.to_campus_id
      ${isGlobal ? '' : 'AND (co.from_campus_id = ' + Number(req.user.campus_id) + ' OR co.to_campus_id = ' + Number(req.user.campus_id) + ')'}
      ORDER BY co.id DESC LIMIT 20`).all();

    const inUseRate = totals.total > 0 ? Math.round((totals.in_use / totals.total) * 100) : 0;
    res.json({
      totals: { total: totals.total, net_value: totals.net_value || 0, in_use_rate: inUseRate, repairing: totals.repairing || 0, scrap },
      byCampus, byStatus, byCategory, monthly, pendingDisposals, pivot, transfers,
    });
  } catch (e) { next(e); }
});

// 我的待办：待我审批/执行的单据（superadmin 继承 admin 的执行类待办）
router.get('/todo', (req, res, next) => {
  try {
    const u = req.user;
    const todos = [];
    if (hasRole(u, 'admin')) {
      todos.push(...db.prepare(`SELECT 'usage' AS kind, uo.id, uo.order_no, a.name AS title, uo.status AS step FROM usage_orders uo JOIN assets a ON a.id=uo.asset_id WHERE uo.status='已批准'`).all()
        .map((t) => ({ ...t, action: '行政执行' })));
      todos.push(...db.prepare(`SELECT 'purchase' AS kind, po.id, po.order_no, c.name AS title, po.status AS step FROM purchase_orders po JOIN campuses c ON c.id=po.campus_id WHERE po.status='待验收'`).all()
        .map((t) => ({ ...t, action: '验收' })));
      todos.push(...db.prepare(`SELECT 'change' AS kind, co.id, co.order_no, a.name AS title, co.current_step AS step FROM change_orders co JOIN assets a ON a.id=co.asset_id WHERE co.status='待审批' AND co.current_step='admin_exec'`).all()
        .map((t) => ({ ...t, action: '行政执行' })));
    }
    if (u.role === 'head') {
      todos.push(...db.prepare(`SELECT 'usage' AS kind, uo.id, uo.order_no, a.name AS title, uo.status AS step FROM usage_orders uo JOIN assets a ON a.id=uo.asset_id WHERE uo.status='待审批' AND uo.campus_id=?`).all(u.campus_id)
        .map((t) => ({ ...t, action: '审批' })));
      todos.push(...db.prepare(`SELECT 'change' AS kind, co.id, co.order_no, a.name AS title, co.current_step AS step FROM change_orders co JOIN assets a ON a.id=co.asset_id
        WHERE co.status='待审批' AND ((co.current_step='head_from' AND co.from_campus_id=?) OR (co.current_step='head_to' AND co.to_campus_id=?))`).all(u.campus_id, u.campus_id)
        .map((t) => ({ ...t, action: '审批' })));
    }
    if (hasRole(u, 'finance')) {
      todos.push(...db.prepare(`SELECT 'change' AS kind, co.id, co.order_no, a.name AS title, co.current_step AS step FROM change_orders co JOIN assets a ON a.id=co.asset_id WHERE co.status='待审批' AND co.current_step='finance'`).all()
        .map((t) => ({ ...t, action: '财务审核' })));
    }
    res.json(todos);
  } catch (e) { next(e); }
});

module.exports = router;
