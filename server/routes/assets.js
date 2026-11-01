// 资产台账：主数据出口 + 月度折旧计提 + 图片上传
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireRole, campusScope, hasRole } = require('../middleware/auth');
const { requireFields, notFound, forbidden, badRequest, nextAssetNo, nextGroupNo, curMonthYm, nextMonthYm, monthDiff } = require('../util');

const router = express.Router();
router.use(requireAuth);

const oss = require('../oss');
const ledgerExport = require('../ledger-export');

// OSS 启用时先收进内存再推 Bucket（不落 VPS 磁盘）；未启用时落本地 uploads 目录
const upload = multer({
  storage: oss.enabled ? multer.memoryStorage() : multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持图片文件'));
  },
});

// 图片上传（多图）
router.post('/upload', upload.array('files', 9), async (req, res, next) => {
  try {
    if (oss.enabled) {
      const urls = [];
      for (const f of req.files) urls.push(await oss.put(f.buffer, f.originalname));
      return res.json({ files: urls });
    }
    res.json({ files: req.files.map((f) => `/uploads/${f.filename}`) });
  } catch (e) { next(e); }
});

// multer 错误（超限/类型不符）转为友好提示，避免笼统的「服务器内部错误」
router.use('/upload', (err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片超过 50MB 大小限制，请压缩后再试' : `上传失败：${err.message}`;
    return res.status(400).json({ error: { code: 'UPLOAD_FAILED', message: msg } });
  }
  next(err);
});

// 折旧口径：年限平均法（直线法），月折旧 = 原值 × (1 - 净残值率) ÷ 折旧月数；当月录入次月起计提
function depInfo(a) {
  const salvageRate = a.salvage_rate != null ? a.salvage_rate : 0.05;
  const months = a.dep_months || (a.life_years ? a.life_years * 12 : 0);
  const base = Math.round(a.original_value * (1 - salvageRate) * 100) / 100; // 应计提总额
  const monthly = months > 0 ? Math.round((a.original_value * (1 - salvageRate) / months) * 100) / 100 : 0;
  let remainingMonths = null;
  if (a.dep_start_month && months > 0) {
    const elapsed = Math.max(0, monthDiff(a.dep_start_month, curMonthYm()) + 1); // 起始月算第 1 个月
    remainingMonths = Math.max(0, months - elapsed);
  }
  return { salvage_rate: salvageRate, dep_months: months, dep_base: base, monthly_dep: monthly, remaining_months: remainingMonths };
}

function assetView(a, user) {
  const canSeeAmount = hasRole(user, 'admin', 'finance', 'principal', 'head');
  return {
    ...a,
    photos: JSON.parse(a.photos || '[]'),
    attachments: JSON.parse(a.attachments || '[]'),
    net_value: canSeeAmount ? Math.round((a.original_value - a.acc_depreciation) * 100) / 100 : undefined,
    original_value: canSeeAmount ? a.original_value : undefined,
    acc_depreciation: canSeeAmount ? a.acc_depreciation : undefined,
    ...(canSeeAmount && a.original_value > 0 ? depInfo(a) : {}),
  };
}

const BASE_SQL = `
  SELECT a.*, c.name AS campus_name, c.code AS campus_code, cat.name AS category_name, cat.code AS category_code,
         cat.life_years, cat.salvage_rate,
         l.name AS location_name, u.name AS user_name
  FROM assets a
  JOIN campuses c ON c.id=a.campus_id
  JOIN categories cat ON cat.id=a.category_id
  LEFT JOIN locations l ON l.id=a.location_id
  LEFT JOIN users u ON u.id=a.user_id`;

// 列表：?campus_id=&status=&category_id=&source=&q=&mine=1
router.get('/', (req, res) => {
  const scope = campusScope(req.user, 'a.campus_id');
  const conds = [scope.where];
  const params = [...scope.params];
  if (req.query.campus_id) { conds.push('a.campus_id=?'); params.push(req.query.campus_id); }
  if (req.query.status) { conds.push('a.status=?'); params.push(req.query.status); }
  if (req.query.category_id) { conds.push('a.category_id=?'); params.push(req.query.category_id); }
  if (req.query.source) { conds.push('a.source=?'); params.push(req.query.source); }
  if (req.query.q) { conds.push('(a.name LIKE ? OR a.asset_no LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  if (req.query.group_no) { conds.push('a.group_no=?'); params.push(req.query.group_no); }
  if (req.query.mine === '1') { conds.push('a.user_id=?'); params.push(req.user.id); }
  if (req.user.role === 'teacher') { conds.push('a.user_id=?'); params.push(req.user.id); } // 教师只看本人使用
  const rows = db.prepare(`${BASE_SQL} WHERE ${conds.join(' AND ')} ORDER BY a.id DESC`).all(...params);
  res.json(rows.map((r) => assetView(r, req.user)));
});

// 台账导出（金蝶精斗云固定资产导入模板，39 列）：?campus_id=&status=&category_id=&source=&q=
// 按校区导出：传 campus_id 导出单个校区，不传导出权限范围内全部校区（使用部门列区分）
router.get('/export', async (req, res, next) => {
  try {
    if (!hasRole(req.user, 'admin', 'finance', 'principal', 'head')) throw forbidden('仅行政、财务、校长、校区负责人可导出台账');
    const scope = campusScope(req.user, 'a.campus_id');
    const conds = [scope.where];
    const params = [...scope.params];
    if (req.query.campus_id) { conds.push('a.campus_id=?'); params.push(req.query.campus_id); }
    if (req.query.status) { conds.push('a.status=?'); params.push(req.query.status); }
    else conds.push("a.status != '已报废'"); // 已报废由财务在金蝶内做清理，不进入导入台账
    if (req.query.category_id) { conds.push('a.category_id=?'); params.push(req.query.category_id); }
    if (req.query.source) { conds.push('a.source=?'); params.push(req.query.source); }
    if (req.query.q) { conds.push('(a.name LIKE ? OR a.asset_no LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const rows = db.prepare(`${BASE_SQL} WHERE ${conds.join(' AND ')} ORDER BY a.asset_no`).all(...params);

    // 本年已折旧：按计提日志汇总（日志表为计提时懒建，缺失视为 0）
    const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accrual_log'").get();
    const curYear = String(new Date().getFullYear());
    const yearStmt = hasLog ? db.prepare("SELECT COALESCE(SUM(amount),0) s FROM accrual_log WHERE asset_id=? AND month LIKE ?") : null;
    for (const a of rows) a.year_dep = yearStmt ? yearStmt.get(a.id, `${curYear}-%`).s : 0;

    const wb = await ledgerExport.buildWorkbook(rows);
    const campus = req.query.campus_id ? db.prepare('SELECT name FROM campuses WHERE id=?').get(req.query.campus_id) : null;
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const fname = `固定资产台账-${campus ? campus.name : '全部校区'}-${ymd}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

router.get('/:id(\\d+)', (req, res, next) => {
  try {
    const a = db.prepare(`${BASE_SQL} WHERE a.id=?`).get(req.params.id);
    if (!a) throw notFound('资产不存在');
    if (!hasRole(req.user, 'admin', 'finance', 'principal') && a.campus_id !== req.user.campus_id) throw forbidden('无权查看其他校区资产');
    if (req.user.role === 'teacher' && a.user_id !== req.user.id) throw forbidden('教师仅可查看本人使用的资产');
    // 关联历史单据
    const usages = db.prepare(`SELECT uo.*, u.name AS user_name FROM usage_orders uo LEFT JOIN users u ON u.id=uo.user_id WHERE uo.asset_id=? ORDER BY uo.id DESC LIMIT 20`).all(a.id);
    const changes = db.prepare(`SELECT co.*, fc.name AS from_campus_name, tc.name AS to_campus_name FROM change_orders co
      JOIN campuses fc ON fc.id=co.from_campus_id LEFT JOIN campuses tc ON tc.id=co.to_campus_id WHERE co.asset_id=? ORDER BY co.id DESC LIMIT 20`).all(a.id);
    const group_count = a.group_no ? db.prepare('SELECT COUNT(*) c FROM assets WHERE group_no=?').get(a.group_no).c : 0;
    res.json({ ...assetView(a, req.user), usages, changes, group_count });
  } catch (e) { next(e); }
});

// 手动新增台账（行政）：原值与购置日期可选（信息缺失时按 0 / 空处理，不编造）
router.post('/', requireRole('admin'), (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'campus_id', 'category_id']);
    const campus = db.prepare('SELECT * FROM campuses WHERE id=?').get(req.body.campus_id);
    const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(req.body.category_id);
    if (!campus || !cat) throw notFound('校区或分类不存在');
    const assetNo = nextAssetNo(campus.code, cat.code);
    // 折旧：默认次月起计提（当月录入不算），折旧月数默认分类年限×12，可显式指定
    const depStart = req.body.dep_start_month || nextMonthYm();
    const depMonths = req.body.dep_months ? Math.max(1, parseInt(req.body.dep_months, 10)) : cat.life_years * 12;
    const r = db.prepare(`INSERT INTO assets (asset_no,name,photos,attachments,campus_id,category_id,location_id,user_id,status,original_value,purchase_date,remark,source,brand,spec,dep_start_month,dep_months)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      assetNo, req.body.name, JSON.stringify(req.body.photos || []), JSON.stringify(req.body.attachments || []),
      campus.id, cat.id, req.body.location_id || null, req.body.user_id || null,
      req.body.status || '在用', Number(req.body.original_value || 0), req.body.purchase_date || null, req.body.remark || null,
      '手动新增', req.body.brand || null, req.body.spec || null, depStart, depMonths);
    res.status(201).json({ id: r.lastInsertRowid, asset_no: assetNo });
  } catch (e) { next(e); }
});

// 期初建档（批量）：存量资产补录，仅名称+分类必填，金额/日期可留空
// 行政可为任意校区建档；校区负责人可为本校区建档；每行按数量逐件展开，独立编号，可附照片
router.post('/initial', requireRole('admin', 'head'), (req, res, next) => {
  try {
    requireFields(req.body, ['campus_id', 'items']);
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) throw badRequest('建档明细不能为空');
    const campus = db.prepare("SELECT * FROM campuses WHERE id=? AND status='启用'").get(req.body.campus_id);
    if (!campus) throw notFound('校区不存在或已停用');
    if (req.user.role === 'head' && req.user.campus_id !== campus.id) throw forbidden('校区负责人仅可为本校区建档');
    for (const it of items) requireFields(it, ['name', 'category_id']);

    const created = [];
    const tx = db.transaction(() => {
      const ins = db.prepare(`INSERT INTO assets (asset_no,name,photos,campus_id,category_id,location_id,status,original_value,purchase_date,remark,source,brand,spec,dep_start_month,dep_months,group_no)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const groupBase = db.prepare('SELECT COUNT(DISTINCT group_no) c FROM assets WHERE group_no IS NOT NULL').get().c;
      let gSeq = groupBase;
      for (const it of items) {
        const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(it.category_id);
        if (!cat) throw notFound(`分类不存在: ${it.category_id}`);
        const qty = Math.max(1, parseInt(it.qty || 1, 10));
        const photos = Array.isArray(it.photos) ? it.photos : [];
        // 折旧：次月起计提；折旧月数默认分类年限×12，老资产可按剩余可用时间填；同批多件编为一个资产组（组内折旧时间一致）
        const depStart = it.dep_start_month || nextMonthYm();
        const depMonths = it.dep_months ? Math.max(1, parseInt(it.dep_months, 10)) : cat.life_years * 12;
        const groupNo = qty > 1 ? nextGroupNo(campus.code, cat.code, ++gSeq) : null;
        for (let i = 0; i < qty; i++) {
          const assetNo = nextAssetNo(campus.code, cat.code);
          const name = qty > 1 ? `${it.name} ${i + 1}/${qty}` : it.name;
          const r = ins.run(assetNo, name, JSON.stringify(photos), campus.id, cat.id,
            it.location_id || null, it.status || '在用', Number(it.original_value || 0),
            it.purchase_date || null, it.remark || null, '期初建档', it.brand || null, it.spec || null,
            depStart, depMonths, groupNo);
          created.push({ id: r.lastInsertRowid, asset_no: assetNo, name, group_no: groupNo });
        }
      }
    });
    tx();
    res.status(201).json({ created_count: created.length, created });
  } catch (e) { next(e); }
});

router.put('/:id(\\d+)', requireRole('admin'), (req, res, next) => {
  try {
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!a) throw notFound('资产不存在');
    const b = req.body;
    db.prepare(`UPDATE assets SET name=?, photos=?, attachments=?, category_id=?, location_id=?, user_id=?, original_value=?, purchase_date=?, remark=?, brand=?, spec=?, status=?, dep_start_month=?, dep_months=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(b.name ?? a.name, JSON.stringify(b.photos ?? JSON.parse(a.photos)), JSON.stringify(b.attachments ?? JSON.parse(a.attachments)),
        b.category_id ?? a.category_id, b.location_id ?? a.location_id, b.user_id !== undefined ? b.user_id : a.user_id,
        b.original_value ?? a.original_value, b.purchase_date !== undefined ? b.purchase_date : a.purchase_date, b.remark ?? a.remark,
        b.brand !== undefined ? b.brand : a.brand, b.spec !== undefined ? b.spec : a.spec,
        b.status && ['在用', '闲置', '借用中', '维修中', '已报废'].includes(b.status) ? b.status : a.status,
        b.dep_start_month !== undefined ? (b.dep_start_month || null) : a.dep_start_month,
        b.dep_months !== undefined ? (b.dep_months ? Math.max(1, parseInt(b.dep_months, 10)) : null) : a.dep_months,
        a.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 月度折旧计提（年限平均法：月折旧 = 原值 × (1-净残值率) ÷ 折旧月数）
// 规则：当月录入不算、次月开始计提（dep_start_month 门控）；提足应计提总额后停止；幂等：每资产每月只计提一次
router.post('/accrue', requireRole('admin', 'finance'), (req, res, next) => {
  try {
    const month = curMonthYm();
    db.exec("CREATE TABLE IF NOT EXISTS accrual_log (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, month TEXT NOT NULL, amount REAL NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(asset_id, month))");
    const assets = db.prepare(`
      SELECT a.*, COALESCE(a.dep_months, c.life_years * 12) AS dep_months_eff, COALESCE(c.salvage_rate, 0.05) AS salvage_rate
      FROM assets a JOIN categories c ON c.id=a.category_id
      WHERE a.status != '已报废' AND a.original_value > 0`).all();
    let count = 0;
    const tx = db.transaction(() => {
      for (const a of assets) {
        if (!a.dep_start_month || a.dep_start_month > month) continue; // 未到期（次月起算）
        const logged = db.prepare('SELECT 1 FROM accrual_log WHERE asset_id=? AND month=?').get(a.id, month);
        if (logged) continue;
        const base = Math.round(a.original_value * (1 - a.salvage_rate) * 100) / 100; // 应计提总额
        if (a.acc_depreciation >= base) continue; // 已提足
        const monthly = Math.round((a.original_value * (1 - a.salvage_rate) / a.dep_months_eff) * 100) / 100;
        const newAcc = Math.min(base, Math.round((a.acc_depreciation + monthly) * 100) / 100);
        db.prepare("UPDATE assets SET acc_depreciation=?, updated_at=datetime('now','localtime') WHERE id=?").run(newAcc, a.id);
        db.prepare('INSERT INTO accrual_log (asset_id, month, amount) VALUES (?,?,?)').run(a.id, month, Math.round((newAcc - a.acc_depreciation) * 100) / 100);
        count++;
      }
    });
    tx();
    res.json({ ok: true, accrued: count, month });
  } catch (e) { next(e); }
});

module.exports = router;
