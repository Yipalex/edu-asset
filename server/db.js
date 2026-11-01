// 数据库：Schema 定义与种子数据（可重复启动，种子仅在空库时写入）
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');
const fs = require('fs');
const path = require('path');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS campuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  head_user_id INTEGER,
  status TEXT NOT NULL DEFAULT '启用'
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  life_years INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT '启用'
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  campus_id INTEGER NOT NULL REFERENCES campuses(id),
  department TEXT,
  status TEXT NOT NULL DEFAULT '启用'
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('superadmin','admin','head','teacher','finance','principal')),
  campus_id INTEGER REFERENCES campuses(id),
  department TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  photos TEXT NOT NULL DEFAULT '[]',
  attachments TEXT NOT NULL DEFAULT '[]',
  campus_id INTEGER NOT NULL REFERENCES campuses(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  location_id INTEGER REFERENCES locations(id),
  user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT '在用' CHECK(status IN ('在用','闲置','借用中','维修中','已报废')),
  original_value REAL NOT NULL DEFAULT 0,
  acc_depreciation REAL NOT NULL DEFAULT 0,
  purchase_date TEXT,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  campus_id INTEGER NOT NULL REFERENCES campuses(id),
  arrive_date TEXT,
  inspector_id INTEGER REFERENCES users(id),
  result TEXT,
  status TEXT NOT NULL DEFAULT '待验收' CHECK(status IN ('待验收','验收通过','验收不通过')),
  remark TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  photos TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS usage_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  campus_id INTEGER NOT NULL REFERENCES campuses(id),
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('领用','借用')),
  expected_return TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT '待审批' CHECK(status IN ('待审批','已批准','已执行','已拒绝','已归还')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS change_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  type TEXT NOT NULL CHECK(type IN ('调拨','维修','报废')),
  from_campus_id INTEGER NOT NULL REFERENCES campuses(id),
  to_campus_id INTEGER REFERENCES campuses(id),
  to_location_id INTEGER REFERENCES locations(id),
  receiver_id INTEGER REFERENCES users(id),
  fee REAL NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT '待审批' CHECK(status IN ('待审批','已拒绝','已完成')),
  current_step TEXT NOT NULL DEFAULT 'head_from' CHECK(current_step IN ('head_from','head_to','finance','admin_exec','done')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_type TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  step TEXT NOT NULL,
  approver_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS inventory_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  campus_id INTEGER NOT NULL REFERENCES campuses(id),
  deadline TEXT,
  status TEXT NOT NULL DEFAULT '进行中' CHECK(status IN ('进行中','已完成')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES inventory_tasks(id),
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  in_book TEXT DEFAULT '在账',
  result TEXT CHECK(result IN ('一致','盘亏','信息不符')),
  photos TEXT NOT NULL DEFAULT '[]',
  checked_by INTEGER REFERENCES users(id),
  checked_at TEXT
);
`);

// ---------- 轻量迁移（幂等，仅新增列；对已有线上数据安全） ----------
function ensureColumns(table, cols) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, ddl] of cols) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
      console.log(`[DB] 迁移: ${table}.${name} 已新增`);
    }
  }
}

// assets.source 记录资产入账来源：期初建档（存量盘点补录）/ 采购入库 / 手动新增
// brand、spec 用于补录品牌与配置（期初建档时可留空，后续完善）
// dep_start_month=折旧起始月(YYYY-MM)，null=暂不计提；dep_months=折旧总月数，null=按分类年限；group_no=资产组编号
ensureColumns('assets', [
  ['source', "TEXT NOT NULL DEFAULT '手动新增'"],
  ['brand', 'TEXT'],
  ['spec', 'TEXT'],
  ['dep_start_month', 'TEXT'],
  ['dep_months', 'INTEGER'],
  ['group_no', 'TEXT'],
]);

// categories.salvage_rate=净残值率（年限平均法计提基数 = 原值 × (1 - 残值率)）
ensureColumns('categories', [
  ['salvage_rate', 'REAL NOT NULL DEFAULT 0.05'],
]);

// ---------- 一次性标准化资产分类（幂等，app_meta 标记）：按财务系统口径统一 6 类 + 残值率 5% ----------
// 房屋建筑物20 / 机器机械生产设备10 / 器具工具家具5 / 运输工具4 / 电子设备3 / 其他固定资产5（编码与财务系统一致 001-006）
const STANDARD_CATS = [
  ['房屋、建筑物', '001', 20],
  ['机器机械生产设备', '002', 10],
  ['器具、工具、家具', '003', 5],
  ['运输工具', '004', 4],
  ['电子设备', '005', 3],
  ['其他固定资产', '006', 5],
];
{
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get()) {
    db.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)");
  }
  const meta = db.prepare("SELECT value FROM app_meta WHERE key='std_categories_done'").get();
  if (!meta) {
    const tx = db.transaction(() => {
      const find = db.prepare('SELECT id FROM categories WHERE name=?');
      const byCode = db.prepare('SELECT id,name FROM categories WHERE code=?');
      const upd = db.prepare("UPDATE categories SET code=?, life_years=?, salvage_rate=0.05, status='启用' WHERE id=?");
      const ins = db.prepare('INSERT INTO categories (name,code,life_years,salvage_rate) VALUES (?,?,?,0.05)');
      const usedAssets = db.prepare('SELECT COUNT(*) c FROM assets WHERE category_id=?');
      const usedPurchases = db.prepare('SELECT COUNT(*) c FROM purchase_items WHERE category_id=?');
      const del = db.prepare('DELETE FROM categories WHERE id=?');
      const reCode = db.prepare('UPDATE categories SET code=? WHERE id=?');
      // 把目标编码腾出来：占用者未被引用则删除；被引用则挪到备用编码，绝不因 UNIQUE 冲突中断迁移
      const freeCode = (code, selfId) => {
        let occ = byCode.get(code);
        while (occ && occ.id !== selfId) {
          if (usedAssets.get(occ.id).c === 0 && usedPurchases.get(occ.id).c === 0) {
            del.run(occ.id);
          } else {
            let alt = '9' + code;
            while (byCode.get(alt)) alt = '9' + alt;
            reCode.run(alt, occ.id);
          }
          occ = byCode.get(code);
        }
      };
      for (const [name, code, life] of STANDARD_CATS) {
        const ex = find.get(name);
        if (ex) {
          freeCode(code, ex.id);
          upd.run(code, life, ex.id);
        } else {
          freeCode(code, null);
          ins.run(name, code, life);
        }
      }
      // 删除未被引用的非标准旧分类（生产库 0 资产可直接清掉演示类别；有引用的一律保留，避免破坏历史台账）
      const stdNames = STANDARD_CATS.map((x) => x[0]);
      const ph = stdNames.map(() => '?').join(',');
      const others = db.prepare(`SELECT id,name FROM categories WHERE name NOT IN (${ph})`).all(...stdNames);
      const dis = db.prepare("UPDATE categories SET status='停用' WHERE id=?");
      for (const c of others) {
        if (usedAssets.get(c.id).c === 0 && usedPurchases.get(c.id).c === 0) del.run(c.id);
        else dis.run(c.id);
      }
      db.prepare("INSERT INTO app_meta (key,value) VALUES ('std_categories_done', datetime('now','localtime'))").run();
    });
    tx();
    console.log('[DB] 迁移: 资产分类已标准化（残值率 5%）');
  }
}

// ---------- v2 分类归一化（2026-10-30）：对齐财务系统 6 类（编码 001-006，名称微调 + 新增其他固定资产）----------
// 生产库已跑过 v1（5 类 01-05），此块把旧名/旧码升级到最终 6 类；新库 v1 已直接建最终 6 类，此块仅落标记
{
  const LEGACY_CATS = {
    // 最终名称: [旧名称, 旧编码]
    '房屋、建筑物': ['房屋建筑物', '01'],
    '机器机械生产设备': ['机器、机械', '02'],
    '器具、工具、家具': ['器具、工具', '05'],
    '运输工具': ['运输工具', '04'],
    '电子设备': ['电子设备', '03'],
    '其他固定资产': [null, null],
  };
  const meta2 = db.prepare("SELECT value FROM app_meta WHERE key='std_categories_v2_done'").get();
  if (!meta2) {
    const tx = db.transaction(() => {
      const findByName = db.prepare('SELECT id FROM categories WHERE name=?');
      const byCode = db.prepare('SELECT id,name FROM categories WHERE code=?');
      const upd = db.prepare("UPDATE categories SET name=?, code=?, life_years=?, salvage_rate=0.05, status='启用' WHERE id=?");
      const ins = db.prepare('INSERT INTO categories (name,code,life_years,salvage_rate) VALUES (?,?,?,0.05)');
      const usedAssets = db.prepare('SELECT COUNT(*) c FROM assets WHERE category_id=?');
      const usedPurchases = db.prepare('SELECT COUNT(*) c FROM purchase_items WHERE category_id=?');
      const del = db.prepare('DELETE FROM categories WHERE id=?');
      const reCode = db.prepare('UPDATE categories SET code=? WHERE id=?');
      const freeCode = (code, selfId) => {
        let occ = byCode.get(code);
        while (occ && occ.id !== selfId) {
          if (usedAssets.get(occ.id).c === 0 && usedPurchases.get(occ.id).c === 0) {
            del.run(occ.id);
          } else {
            let alt = '9' + code;
            while (byCode.get(alt)) alt = '9' + alt;
            reCode.run(alt, occ.id);
          }
          occ = byCode.get(code);
        }
      };
      for (const [name, code, life] of STANDARD_CATS) {
        let row = findByName.get(name);
        if (!row) {
          const [legacyName, legacyCode] = LEGACY_CATS[name] || [null, null];
          if (legacyName) row = findByName.get(legacyName);
          if (!row && legacyCode) row = byCode.get(legacyCode);
        }
        if (row) {
          freeCode(code, row.id);
          upd.run(name, code, life, row.id);
        } else {
          freeCode(code, null);
          ins.run(name, code, life);
        }
      }
      // 清掉未引用的非标准分类（有引用的停用保留）
      const stdNames = STANDARD_CATS.map((x) => x[0]);
      const ph = stdNames.map(() => '?').join(',');
      const others = db.prepare(`SELECT id FROM categories WHERE name NOT IN (${ph})`).all(...stdNames);
      const dis = db.prepare("UPDATE categories SET status='停用' WHERE id=?");
      for (const c of others) {
        if (usedAssets.get(c.id).c === 0 && usedPurchases.get(c.id).c === 0) del.run(c.id);
        else dis.run(c.id);
      }
      db.prepare("INSERT INTO app_meta (key,value) VALUES ('std_categories_v2_done', datetime('now','localtime'))").run();
    });
    tx();
    console.log('[DB] 迁移: 资产分类已对齐财务系统 6 类（001-006）');
  }
}

// 存量资产回填折旧月数（null 的按所属分类年限×12）
db.prepare(`UPDATE assets SET dep_months = (SELECT life_years * 12 FROM categories WHERE categories.id = assets.category_id)
  WHERE dep_months IS NULL`).run();

// ---------- 迁移：users.role CHECK 约束加入 superadmin（重建表，幂等） ----------
// 注意：PRAGMA foreign_keys 在事务内无效，必须在事务外关闭后再重建表
{
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (ddl && !ddl.sql.includes('superadmin')) {
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('superadmin','admin','head','teacher','finance','principal')),
          campus_id INTEGER REFERENCES campuses(id),
          department TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO users_new SELECT id, username, password_hash, name, role, campus_id, department, is_active, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      db.exec('COMMIT');
      console.log('[DB] 迁移: users.role 约束已加入 superadmin');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

// ---------- 一次性「正式启用」迁移：清演示数据 + 建超管（幂等，由环境变量触发） ----------
{
  const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get();
  if (!meta) db.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)");
  const done = db.prepare("SELECT value FROM app_meta WHERE key='prod_init_done'").get();
  const initPwd = process.env.INIT_SUPERADMIN_PASSWORD;
  if (!done && initPwd) {
    const tx = db.transaction(() => {
      // 按外键依赖顺序清理（先单据后资产后账号，避免 SQLITE_CONSTRAINT_FOREIGNKEY）
      const safeDel = (sql) => { try { db.prepare(sql).run(); } catch (e) { /* 表可能不存在（懒建） */ } };
      safeDel('DELETE FROM inventory_items');
      safeDel('DELETE FROM inventory_tasks');
      safeDel('DELETE FROM approvals');
      safeDel('DELETE FROM change_orders');
      safeDel('DELETE FROM usage_orders');
      safeDel('DELETE FROM purchase_items');
      safeDel('DELETE FROM purchase_orders');
      safeDel('DELETE FROM refresh_tokens');
      safeDel('DELETE FROM accrual_log');
      safeDel('DELETE FROM assets');
      safeDel('DELETE FROM users');
      db.prepare('UPDATE campuses SET head_user_id=NULL').run();
      db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('assets','users','inventory_items','inventory_tasks','approvals','change_orders','usage_orders','purchase_items','purchase_orders','refresh_tokens')").run();
      // 创建超级管理员
      const superUser = process.env.SUPERADMIN_USERNAME || '13800000000';
      const superName = process.env.SUPERADMIN_NAME || '超级管理员';
      const zb = db.prepare("SELECT id FROM campuses WHERE code='ZB'").get();
      db.prepare('INSERT INTO users (username,password_hash,name,role,campus_id) VALUES (?,?,?,?,?)')
        .run(superUser, bcrypt.hashSync(initPwd, 10), superName, 'superadmin', zb ? zb.id : null);
      db.prepare("INSERT INTO app_meta (key,value) VALUES ('prod_init_done', datetime('now','localtime'))").run();
    });
    tx();
    console.log(`[DB] 正式启用迁移完成：演示数据已清除，超级管理员 ${process.env.SUPERADMIN_USERNAME || '13800000000'} 已创建`);
  }
}

// ---------- 种子数据（仅空库时）：只建校区/分类/地点字典 + 超级管理员，不再创建任何演示账号或演示资产 ----------
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  // 超管初始密码从环境变量读取（部署时注入），不硬编码在代码库中
  const superPassword = process.env.SUPERADMIN_INIT_PASSWORD;
  if (!superPassword) {
    console.error('[FATAL] 首次初始化需要环境变量 SUPERADMIN_INIT_PASSWORD 以创建超级管理员账号');
    process.exit(1);
  }
  const tx = db.transaction(() => {
    const insCampus = db.prepare('INSERT INTO campuses (name, code) VALUES (?,?)');
    const campuses = [
      ['城东校区校区', 'JC'], ['城西校区校区', 'ST'], ['城南校区', 'HD'],
      ['城北校区', 'MZ'], ['高新区校区', 'KF'], ['总部', 'ZB'],
    ];
    const campusIds = campuses.map(([n, c]) => insCampus.run(n, c).lastInsertRowid);

    const insUser = db.prepare('INSERT INTO users (username,password_hash,name,role,campus_id) VALUES (?,?,?,?,?)');
    const superId = insUser.run(process.env.SUPERADMIN_USERNAME || '13800000000',
      bcrypt.hashSync(superPassword, 10), process.env.SUPERADMIN_NAME || '超级管理员',
      'superadmin', campusIds[5]).lastInsertRowid;
    console.log(`[DB] 已创建超级管理员账号（用户名 ${process.env.SUPERADMIN_USERNAME || '13800000000'}）`);

    const insCat = db.prepare('INSERT OR IGNORE INTO categories (name,code,life_years,salvage_rate) VALUES (?,?,?,0.05)');
    STANDARD_CATS.forEach(([n, c, l]) => insCat.run(n, c, l));

    const insLoc = db.prepare('INSERT INTO locations (name,campus_id,department) VALUES (?,?,?)');
    const locIds = campusIds.map((cid) => insLoc.run('前台/大厅', cid, '行政').lastInsertRowid);
    campusIds.forEach((cid) => insLoc.run('一号教室', cid, '教学'));
    return { superId, locIds };
  });
  tx();
  console.log('[DB] 已写入基础字典（校区/分类/地点）与超级管理员账号');
}

module.exports = db;
