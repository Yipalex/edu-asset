// 台账导出：按金蝶精斗云「固定资产卡片模板」口径生成 xlsx（39 列，列序与模板一致）
// 财务把固定资产录入金蝶精斗云时可直接导入本表。
const ExcelJS = require('exceljs');

// 模板表头（固定资产卡片模板，39 列）
const HEADERS = [
  '固定资产编码', '固定资产名称', '固定资产类别', '使用部门', '开始使用日期', '数量', '规格型号', '存放地点', '使用人', '备注', '状态', '折旧方法', '预计使用期限', '预计残值率%',
  '固定资产科目', '固定资产科目辅助核算', '累计折旧科目', '累计折旧科目辅助核算', '折旧费用科目', '折旧费用科目辅助核算', '多部门折旧费用分摊信息',
  '税金科目', '税金科目辅助核算', '资产购入对方科目', '资产购入对方科目辅助核算', '资产清理科目', '资产清理科目辅助核算',
  '减值准备科目', '减值准备科目辅助核算', '减值准备对方科目', '减值准备对方科目辅助核算', '多部门减值准备对方科目分摊信息',
  '资产原值', '税额', '减值准备', '已折旧期间数', '期初累计折旧', '本年已折旧', '清理期间',
];

// 本系统状态 → 金蝶卡片状态（金蝶字典仅允许「正常/清理」两种，见金蝶云社区：卡片状态错误即状态列值不合法；
// 正常使用中的资产一律「正常」，已报废资产「清理」——默认导出已排除已报废，仅显式筛选时才会出现）
const STATUS_MAP = { '在用': '正常', '借用中': '正常', '维修中': '正常', '闲置': '正常', '已报废': '清理' };

function monthDiff(a, b) {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

// 开始使用日期：本系统口径为「当月录入不算，次月开始计提」，即折旧起始月的前一月开始使用；
// 以 dep_start_month 为准可保证与已折旧期间数、期初累计折旧完全勾稽；无起始月时退回采购日期。
function startDate(a) {
  if (a.dep_start_month) {
    let [y, m] = a.dep_start_month.split('-').map(Number);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}-01`;
  }
  return a.purchase_date || '';
}

// list 元素为 BASE_SQL 查询行（含 campus_name/category_name/life_years/salvage_rate/location_name/user_name），
// 另需 a.year_dep（本年已计提额，由路由按 accrual_log 汇总填入）
function buildRows(list) {
  return list.map((a) => {
    const salvageRate = a.salvage_rate != null ? a.salvage_rate : 0.05;
    const months = a.dep_months || (a.life_years ? a.life_years * 12 : 0);
    const monthly = months > 0 ? Math.round((a.original_value * (1 - salvageRate) / months) * 100) / 100 : 0;
    const acc = a.acc_depreciation || 0;
    // 已折旧期间数 = 累计折旧 ÷ 月折旧（与「期初累计折旧」勾稽，金蝶导入后可对上账）
    const periods = monthly > 0 ? Math.min(months, Math.round(acc / monthly)) : 0;
    const spec = [a.brand, a.spec].filter(Boolean).join(' ');
    return [
      a.asset_no, a.name, a.category_name, a.campus_name, startDate(a), 1, spec,
      a.location_name || '', a.user_name || '', a.remark || '',
      STATUS_MAP[a.status] || '正常',
      months > 0 ? '平均年限法' : '不提折旧',
      months || '', Math.round(salvageRate * 10000) / 100,
      // 第 15-32 列为金蝶账套科目/辅助核算/分摊信息（共 18 列），与资产本身无关，留空由财务在金蝶中维护
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      a.original_value || 0, '', 0, periods, acc, a.year_dep || 0, '',
    ];
  });
}

async function buildWorkbook(list) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '教培机构固定资产管理系统';
  const ws = wb.addWorksheet('固定资产卡片');
  ws.addRow(HEADERS).font = { bold: true };
  for (const r of buildRows(list)) ws.addRow(r);
  ws.columns.forEach((col, i) => {
    col.width = [1, 2, 3, 6, 9].includes(i) ? 22 : 12; // 名称/类别/部门/规格/备注加宽
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return wb;
}

module.exports = { HEADERS, buildRows, buildWorkbook };
