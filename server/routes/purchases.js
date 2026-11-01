// 采购入库单：登记 → 验收 → 通过后按明细批量生成台账
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, hasRole } = require('../middleware/auth');
const { requireFields, notFound, conflict, nextOrderNo, nextAssetNo, badRequest, nextMonthYm } = require('../util');

const router = express.Router();
router.use(requireAuth);

function orderView(o) {
  const items = db.prepare(`SELECT pi.*, c.name AS category_name FROM purchase_items pi JOIN categories c ON c.id=pi.category_id WHERE pi.order_id=?`).all(o.id)
    .map((i) => ({ ...i, photos: JSON.parse(i.photos || '[]') }));
  return { ...o, items };
}

router.get('/', (req, res) => {
  const isAll = hasRole(req.user, 'admin', 'finance', 'principal');
  const rows = isAll
    ? db.prepare(`SELECT po.*, c.name AS campus_name, u.name AS inspector_name FROM purchase_orders po JOIN campuses c ON c.id=po.campus_id LEFT JOIN users u ON u.id=po.inspector_id ORDER BY po.id DESC`).all()
    : db.prepare(`SELECT po.*, c.name AS campus_name, u.name AS inspector_name FROM purchase_orders po JOIN campuses c ON c.id=po.campus_id LEFT JOIN users u ON u.id=po.inspector_id WHERE po.campus_id=? ORDER BY po.id DESC`).all(req.user.campus_id);
  res.json(rows);
});

router.get('/:id(\\d+)', (req, res, next) => {
  try {
    const o = db.prepare(`SELECT po.*, c.name AS campus_name, u.name AS inspector_name FROM purchase_orders po JOIN campuses c ON c.id=po.campus_id LEFT JOIN users u ON u.id=po.inspector_id WHERE po.id=?`).get(req.params.id);
    if (!o) throw notFound('入库单不存在');
    res.json(orderView(o));
  } catch (e) { next(e); }
});

// 提交入库单（行政）
router.post('/', requireRole('admin'), (req, res, next) => {
  try {
    requireFields(req.body, ['campus_id', 'items']);
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) throw badRequest('采购明细不能为空');
    for (const it of items) requireFields(it, ['name', 'category_id', 'qty', 'unit_price']);
    const orderNo = nextOrderNo('RK', 'purchase_orders');
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO purchase_orders (order_no, campus_id, arrive_date, remark, created_by) VALUES (?,?,?,?,?)`)
        .run(orderNo, req.body.campus_id, req.body.arrive_date || new Date().toISOString().slice(0, 10), req.body.remark || null, req.user.id);
      const orderId = r.lastInsertRowid;
      const insItem = db.prepare('INSERT INTO purchase_items (order_id, name, category_id, qty, unit_price, photos) VALUES (?,?,?,?,?,?)');
      for (const it of items) insItem.run(orderId, it.name, it.category_id, it.qty, it.unit_price, JSON.stringify(it.photos || []));
      return orderId;
    });
    const orderId = tx();
    res.status(201).json({ id: orderId, order_no: orderNo });
  } catch (e) { next(e); }
});

// 验收（行政）：通过 → 按明细数量生成台账，照片带入
router.post('/:id(\\d+)/inspect', requireRole('admin'), (req, res, next) => {
  try {
    requireFields(req.body, ['result']);
    if (!['验收通过', '验收不通过'].includes(req.body.result)) throw badRequest('验收结果不合法');
    const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
    if (!o) throw notFound('入库单不存在');
    if (o.status !== '待验收') throw conflict(`当前状态为「${o.status}」，不能重复验收`);

    const generated = [];
    const tx = db.transaction(() => {
      db.prepare('UPDATE purchase_orders SET status=?, result=?, inspector_id=?, remark=? WHERE id=?')
        .run(req.body.result, req.body.result, req.user.id, req.body.remark ?? o.remark, o.id);
      if (req.body.result === '验收通过') {
        const campus = db.prepare('SELECT * FROM campuses WHERE id=?').get(o.campus_id);
        const items = db.prepare('SELECT * FROM purchase_items WHERE order_id=?').all(o.id);
        for (const it of items) {
          const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(it.category_id);
          const photos = JSON.parse(it.photos || '[]');
          for (let i = 0; i < it.qty; i++) {
            const assetNo = nextAssetNo(campus.code, cat.code);
            const name = it.qty > 1 ? `${it.name} #${i + 1}` : it.name;
            const r = db.prepare(`INSERT INTO assets (asset_no, name, photos, campus_id, category_id, status, original_value, purchase_date, source, dep_start_month, dep_months)
              VALUES (?,?,?,?,?,'在用',?,?,'采购入库',?,?)`).run(assetNo, name, JSON.stringify(photos), campus.id, cat.id, it.unit_price, o.arrive_date, nextMonthYm(), cat.life_years * 12);
            generated.push(assetNo);
          }
        }
      }
    });
    tx();
    res.json({ ok: true, generated_assets: generated });
  } catch (e) { next(e); }
});

module.exports = router;
