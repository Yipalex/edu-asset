// 存量上传文件迁移到阿里云 OSS（幂等，可重复执行）
// 用法（容器内）：node server/scripts/migrate-uploads-to-oss.js
// 流程：本地文件 → 推 OSS（键名 = 前缀/原文件名）→ 改数据库引用（/uploads/x → 公网URL）→ 删本地文件
const fs = require('fs');
const path = require('path');
const config = require('../config');
const oss = require('../oss');

if (!oss.enabled) {
  console.error('[迁移] 未配置 OSS_ACCESS_KEY_ID/SECRET，无法迁移');
  process.exit(1);
}

// 引用上传文件的 JSON 列：表名 → [字段...]
const REF_COLUMNS = [
  ['assets', ['photos', 'attachments']],
  ['purchase_items', ['photos']],
  ['inventory_items', ['photos']],
];

const Database = require('better-sqlite3');
const db = new Database(config.dbPath);

async function main() {
  const dir = config.uploadDir;
  if (!fs.existsSync(dir)) { console.log('[迁移] uploads 目录不存在，无需迁移'); return; }
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  console.log(`[迁移] 本地文件 ${files.length} 个，目标 Bucket=${oss.cfg.bucket} 前缀=${oss.cfg.prefix}/`);

  let done = 0, skipped = 0, failed = 0;
  for (const name of files) {
    const local = path.join(dir, name);
    const ossUrl = `${oss.cfg.publicBase}/${oss.cfg.prefix}/${name}`;
    try {
      const head = await oss.getClient().head(`${oss.cfg.prefix}/${name}`).catch(() => null);
      if (!head) {
        await oss.getClient().put(`${oss.cfg.prefix}/${name}`, fs.createReadStream(local));
      }
      // 更新数据库里所有指向 /uploads/name 的引用（仅当尚未改成 OSS URL）
      let refs = 0;
      for (const [table, cols] of REF_COLUMNS) {
        for (const col of cols) {
          const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} LIKE ?`).all(`%/uploads/${name}%`);
          for (const r of rows) {
            const arr = JSON.parse(r.v || '[]');
            const next = arr.map((u) => (u === `/uploads/${name}` ? ossUrl : u));
            if (JSON.stringify(next) !== JSON.stringify(arr)) {
              db.prepare(`UPDATE ${table} SET ${col}=? WHERE id=?`).run(JSON.stringify(next), r.id);
              refs++;
            }
          }
        }
      }
      fs.unlinkSync(local); // OSS 上传成功后才删本地
      done++;
      console.log(`[迁移] OK ${name}${refs ? `（更新 ${refs} 处引用）` : ''}`);
    } catch (e) {
      failed++;
      console.error(`[迁移] 失败 ${name}: ${e.message}`);
    }
  }
  console.log(`[迁移] 完成：成功 ${done}，跳过 ${skipped}，失败 ${failed}`);
}

main().then(() => { db.close(); process.exit(0); }).catch((e) => { console.error(e); db.close(); process.exit(1); });
