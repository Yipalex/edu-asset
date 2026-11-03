// 泽曦书画固定资产管理系统 — 前端 SPA
(function () {
  const app = document.getElementById('app');

  // ---------- 工具 ----------
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMoney = (v) => v === undefined || v === null ? '—' : '¥' + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
  const fmtDate = (s) => (s || '').slice(0, 10) || '—';
  const ROLE_NAMES = { superadmin: '超级管理员', admin: '行政后勤', head: '校区负责人', teacher: '教师', finance: '财务', principal: '校长/管理层' };
  const STATUS_BADGE = { '在用': 'green', '闲置': 'blue', '借用中': 'orange', '维修中': 'red', '已报废': 'gray' };
  const badge = (text, color) => `<span class="badge ${color || STATUS_BADGE[text] || 'blue'}">${h(text)}</span>`;
  // 前端角色判定：superadmin 继承 admin/finance/principal 全部视角（与后端 effectiveRoles 一致）
  const hasR = (u, ...roles) => u.role === 'superadmin' || roles.includes(u.role);

  let toastTimer = null;
  function toast(msg, isErr) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3000);
  }

  function openModal(html) {
    closeModal();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.id = 'modal-mask';
    mask.innerHTML = `<div class="modal">${html}</div>`;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    document.body.appendChild(mask);
    return mask.querySelector('.modal');
  }
  function closeModal() { const m = document.getElementById('modal-mask'); if (m) m.remove(); }

  // 下月（YYYY-MM，本地时区）
  function nextYm() {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // 当月（YYYY-MM）
  function curYm() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function lightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${h(src)}">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  }
  document.addEventListener('click', (e) => {
    if (e.target.matches('img.zoomable')) lightbox(e.target.src);
  });

  // 图片上传组件：返回当前已上传的 url 数组
  // 淘宝式上传层：点 ➕ 弹层，层内支持 Ctrl/⌘+V 粘贴 + 按钮唤起本地选择

  // ---------- 图片压缩：大图自动缩到 2048px 内并转 JPEG，避免高清截图超大传不上 ----------
  async function compressImage(file) {
    if (!/^image\//.test(file.type) || file.type === 'image/gif') return file;
    if (file.size <= 2 * 1024 * 1024) return file; // 2MB 以内直传，保留原格式
    try {
      const bmp = await createImageBitmap(file);
      const MAX = 2048;
      const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], (file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { return file; }
  }

  function photoUploader(container, existing) {
    const urls = [...(existing || [])];
    const render = () => {
      container.innerHTML = urls.map((u, i) =>
        `<div style="position:relative"><img src="${h(u)}" class="zoomable"><span data-del="${i}" style="position:absolute;top:-6px;right:-6px;background:var(--zx-seal);color:#fff;width:18px;height:18px;border-radius:50%;font-size:12px;line-height:18px;text-align:center;cursor:pointer">×</span></div>`
      ).join('') + `<div class="photo-add" id="photo-add" title="点击上传图片（支持粘贴截图）">+</div>`;
      container.querySelector('#photo-add').onclick = openLayer;
      container.querySelectorAll('[data-del]').forEach((el) => {
        el.onclick = () => { urls.splice(Number(el.dataset.del), 1); render(); syncLayerList(); };
      });
    };

    async function uploadFiles(list) {
      if (!list.length) return;
      toast('上传中...');
      try {
        const files = [];
        for (const f of list) files.push(await compressImage(f));
        const r = await api.upload(files);
        urls.push(...r.files);
        render();
        syncLayerList();
        toast(`已上传 ${r.files.length} 张图片`);
      } catch (e) { toast(e.message, true); }
    }

    let layerEl = null;
    const closeLayer = () => {
      if (!layerEl) return;
      document.removeEventListener('paste', onLayerPaste, true);
      layerEl.remove();
      layerEl = null;
    };

    function onLayerPaste(e) {
      const items = Array.from(e.clipboardData?.items || [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
      if (!items.length) return; // 剪贴板不是图片（如复制了文字）则不拦截
      e.preventDefault();
      const files = items.map((it, i) => {
        const f = it.getAsFile();
        return new File([f], f.name || `粘贴图片-${Date.now()}-${i + 1}.png`, { type: f.type || 'image/png' });
      });
      uploadFiles(files);
    }

    function syncLayerList() {
      if (!layerEl) return;
      const box = layerEl.querySelector('#up-list');
      box.innerHTML = urls.length
        ? urls.map((u, i) => `<div style="position:relative"><img src="${h(u)}" class="zoomable" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--border)"><span data-ldel="${i}" style="position:absolute;top:-6px;right:-6px;background:var(--zx-seal);color:#fff;width:18px;height:18px;border-radius:50%;font-size:12px;line-height:18px;text-align:center;cursor:pointer">×</span></div>`).join('')
        : '<div class="muted" style="font-size:12.5px;padding:6px 0">还没有图片，粘贴或选择图片后会显示在这里</div>';
      box.querySelectorAll('[data-ldel]').forEach((el) => {
        el.onclick = () => { urls.splice(Number(el.dataset.ldel), 1); render(); syncLayerList(); };
      });
    }

    function openLayer() {
      if (layerEl) return;
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.style.zIndex = 200;
      mask.innerHTML = `
        <div class="modal" style="max-width:460px">
          <h3 style="margin:0 0 14px;font-size:16px">上传图片</h3>
          <div class="up-paste">
            <div style="font-size:32px;line-height:1">🖼️</div>
            <div style="margin-top:10px;font-size:13.5px;color:var(--text-2)">Ctrl / ⌘ + V 粘贴图片到此处</div>
          </div>
          <div style="display:flex;justify-content:center;margin:16px 0 6px">
            <button class="btn primary" id="up-pick" style="padding:9px 40px;font-size:15px">上传图片</button>
          </div>
          <div class="muted" style="text-align:center;font-size:12px">手机点按钮可选「拍照」或「相册」；单张不超过 50MB</div>
          <div id="up-list" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px"></div>
          <div class="modal-actions" style="margin-top:16px">
            <button class="btn primary" id="up-done" style="padding:8px 40px">完成</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      layerEl = mask;
      mask.addEventListener('click', (e) => { if (e.target === mask) closeLayer(); });
      mask.querySelector('#up-done').onclick = closeLayer;
      mask.querySelector('#up-pick').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
        input.onchange = () => { if (input.files.length) uploadFiles(Array.from(input.files)); };
        input.click();
      };
      document.addEventListener('paste', onLayerPaste, true);
      syncLayerList();
    }

    render();
    return { getUrls: () => urls };
  }

  // ---------- 布局（墨·纸·印 统一骨架 ZXShell） ----------
  const ZX_SYSTEMS = [
    { id: 'yj',   name: '业绩登记系统', domain: 'yj.zexishuhua.com',   color: 'var(--zx-sys-yj)',   url: 'https://yj.zexishuhua.com/' },
    { id: 'quan', name: '券类管理系统', domain: 'quan.zexishuhua.com', color: 'var(--zx-sys-quan)', url: 'https://quan.zexishuhua.com/' },
    { id: 'jz',   name: '教资报名系统', domain: 'jz.zexishuhua.com',   color: 'var(--zx-sys-jz)',   url: 'https://jz.zexishuhua.com/' },
    { id: 'sf',   name: '评测报告系统', domain: 'sf.zexishuhua.com',   color: 'var(--zx-sys-sf)',   url: 'https://sf.zexishuhua.com/' },
    { id: 'wms',  name: '仓库管理系统', domain: 'wms.zexishuhua.com',  color: 'var(--zx-sys-wms)',  url: 'https://wms.zexishuhua.com/' },
    { id: 'zc',   name: '固定资产管理', domain: 'zc.zexishuhua.com',   color: 'var(--zx-sys-zc)',   url: 'https://zc.zexishuhua.com/' },
  ];
  const NAV = [
    { group: '总览', items: [
      { id: 'dashboard', icon: 'chart', label: '资产看板', href: '#/dashboard', roles: ['superadmin', 'admin', 'head', 'finance', 'principal'] },
      { id: 'todo', icon: 'audit', label: '我的待办', href: '#/todo', roles: ['superadmin', 'admin', 'head', 'finance'] },
    ]},
    { group: '资产管理', items: [
      { id: 'assets', icon: 'asset', label: '资产台账', href: '#/assets', roles: ['superadmin', 'admin', 'head', 'teacher', 'finance', 'principal'] },
      { id: 'purchases', icon: 'box', label: '采购入库', href: '#/purchases', roles: ['superadmin', 'admin', 'head', 'finance', 'principal'] },
      { id: 'usages', icon: 'ticket', label: '领用借用', href: '#/usages', roles: ['superadmin', 'admin', 'head', 'teacher', 'finance', 'principal'] },
      { id: 'changes', icon: 'report', label: '资产变动', href: '#/changes', roles: ['superadmin', 'admin', 'head', 'teacher', 'finance', 'principal'] },
      { id: 'inventory', icon: 'scan', label: '资产盘点', href: '#/inventory', roles: ['superadmin', 'admin', 'head', 'teacher', 'finance', 'principal'] },
    ]},
    { group: '系统', items: [
      { id: 'users', icon: 'users', label: '用户与权限', href: '#/users', roles: ['superadmin'] },
      { id: 'admin', icon: 'settings', label: '基础数据', href: '#/admin', roles: ['superadmin', 'admin'] },
      { id: 'pwd', icon: 'me', label: '修改密码', href: 'javascript:void(0)' },
      { id: 'more', icon: 'more', label: '更多', href: '#/more', roles: ['superadmin', 'admin', 'head', 'teacher', 'finance', 'principal'] },
    ]},
  ];

  let zxShellReady = false;
  function ensureShell() {
    if (zxShellReady) return;
    const u = api.getUser();
    if (!u) return;
    zxShellReady = true;
    ZXShell.init({
      brand: { name: '泽曦书画', logo: '/img/zexi-logo.png' },
      systems: ZX_SYSTEMS,
      currentSystem: 'zc',
      nav: NAV,
      tabbar: ['dashboard', 'assets', 'todo', 'inventory', 'more'],
      user: { name: u.name, role: ROLE_NAMES[u.role] || u.role, roleType: u.role },
      activeNav: '',
      onNavigate: (id) => { if (id === 'pwd') { changePasswordForm(); return false; } },
      onLogout: () => api.logout(),
    });
  }
  function syncShellNav(activePath) {
    if (!zxShellReady) return;
    const id = (activePath || '').replace(/^#\//, '');
    document.querySelectorAll('[data-nav]').forEach((a) => {
      a.classList.toggle('is-active', a.getAttribute('data-nav') === id);
    });
  }

  function layout(contentHtml, activePath) {
    ensureShell();
    syncShellNav(activePath);
    app.innerHTML = contentHtml;
  }

  function topbar(title, extra) {
    const u = api.getUser();
    return `<div class="pg-head"><h2>${h(title)}</h2><div class="pg-extra">${extra || ''}<span class="pg-user">${h(u.name)} · ${ROLE_NAMES[u.role]}${u.campus_name ? ' · ' + h(u.campus_name) : ''}</span></div></div>`;
  }

  // ---------- 登录页 ----------
  function renderLogin() {
    app.innerHTML = `
      <div class="login-wrap"><div class="login-card">
        <div class="login-logo"><img src="/img/zexi-logo.png" alt="泽曦书画"></div>
        <h1>固定资产管理系统</h1>
        <div class="sub">泽曦书画 · 多校区资产全生命周期管理</div>
        <input id="login-username" placeholder="手机号 / 用户名" autocomplete="username">
        <input id="login-password" type="password" placeholder="密码" autocomplete="current-password">
        <button class="btn primary btn-block" id="login-btn">登 录</button>
      </div></div>`;
    const doLogin = async () => {
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      if (!username || !password) return toast('请输入用户名和密码', true);
      try {
        const r = await api.post('/api/auth/login', { username, password });
        api.saveTokens(r.accessToken, r.refreshToken, r.user);
        location.hash = '#/dashboard';
      } catch (e) { toast(e.message, true); }
    };
    document.getElementById('login-btn').onclick = doLogin;
    document.getElementById('login-password').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  }

  // ---------- 看板 ----------
  let charts = [];
  async function renderDashboard() {
    const u = api.getUser();
    if (!hasR(u, 'admin', 'head', 'finance', 'principal')) return void (location.hash = '#/assets');
    layout(topbar('资产总览看板') + `<div id="dash-body"><div class="empty">加载中...</div></div>`, '#/dashboard');
    let d;
    try { d = await api.get('/api/dashboard/summary'); } catch (e) { return toast(e.message, true); }
    const canSeeMoney = u.role !== 'head' || true; // head 可看本校区金额
    document.getElementById('dash-body').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi"><div class="label">资产总数（在账）</div><div class="value">${d.totals.total}</div></div>
        <div class="kpi"><div class="label">资产净值合计</div><div class="value">${fmtMoney(d.totals.net_value)}</div></div>
        <div class="kpi"><div class="label">在用率</div><div class="value">${d.totals.in_use_rate}%</div></div>
        <div class="kpi"><div class="label">维修中 / 已报废</div><div class="value red">${d.totals.repairing} / ${d.totals.scrap}</div></div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>按校区对比（数量 / 净值）</h3><canvas id="ch-campus" height="180"></canvas></div>
        <div class="card"><h3>资产状态分布</h3><canvas id="ch-status" height="180"></canvas></div>
        <div class="card"><h3>按分类统计（数量 / 原值）</h3><canvas id="ch-cat" height="180"></canvas></div>
        <div class="card"><h3>近 12 个月采购金额趋势</h3><canvas id="ch-month" height="180"></canvas></div>
      </div>
      <div class="card"><h3>校区 × 状态 透视</h3><div class="table-wrap"><table>
        <thead><tr><th>校区</th>${['在用','闲置','借用中','维修中','已报废'].map((s) => `<th>${s}</th>`).join('')}</tr></thead>
        <tbody>${(() => {
          const campuses = [...new Set(d.pivot.map((p) => p.campus))];
          return campuses.map((c) => `<tr><td>${h(c)}</td>${['在用','闲置','借用中','维修中','已报废'].map((s) => {
            const row = d.pivot.find((p) => p.campus === c && p.status === s);
            return `<td>${row ? row.c : 0}</td>`;
          }).join('')}</tr>`).join('') || '<tr><td colspan="6" class="empty">暂无数据</td></tr>';
        })()}</tbody></table></div></div>
      <div class="grid-2">
        <div class="card"><h3>待处置资产（维修/报废）</h3><div class="table-wrap"><table>
          <thead><tr><th>照片</th><th>编号</th><th>名称</th><th>校区</th><th>状态</th></tr></thead>
          <tbody>${d.pendingDisposals.map((p) => `<tr><td>${p.photos[0] ? `<img class="thumb zoomable" src="${h(p.photos[0])}">` : '<span class="thumb"></span>'}</td><td>${h(p.asset_no)}</td><td>${h(p.name)}</td><td>${h(p.campus_name)}</td><td>${badge(p.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无待处置资产</td></tr>'}</tbody>
        </table></div></div>
        <div class="card"><h3>跨校区调拨记录</h3><div class="table-wrap"><table>
          <thead><tr><th>单号</th><th>资产</th><th>调出</th><th>调入</th><th>状态</th></tr></thead>
          <tbody>${d.transfers.map((t) => `<tr><td>${h(t.order_no)}</td><td>${h(t.asset_name)}</td><td>${h(t.from_campus)}</td><td>${h(t.to_campus || '—')}</td><td>${badge(t.status, t.status === '已完成' ? 'green' : t.status === '已拒绝' ? 'red' : 'orange')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无调拨记录</td></tr>'}</tbody>
        </table></div></div>
      </div>`;
    if (typeof Chart === 'undefined') return;
    charts.forEach((c) => c.destroy()); charts = [];
    const mk = (id, cfg) => { const el = document.getElementById(id); if (el) charts.push(new Chart(el, cfg)); };
    mk('ch-campus', { type: 'bar', data: { labels: d.byCampus.map((c) => c.name), datasets: [
      { label: '数量', data: d.byCampus.map((c) => c.count), backgroundColor: '#31565E' },
      { label: '净值(¥)', data: d.byCampus.map((c) => c.net_value), backgroundColor: '#6E929B', yAxisID: 'y1' }] },
      options: { scales: { y1: { position: 'right', grid: { drawOnChartArea: false } } } } });
    mk('ch-status', { type: 'doughnut', data: { labels: d.byStatus.map((s) => s.status), datasets: [{ data: d.byStatus.map((s) => s.c),
      backgroundColor: ['#3E7C4F', '#31565E', '#A9762B', '#B03A2A', '#8A847B'] }] } });
    mk('ch-cat', { type: 'bar', data: { labels: d.byCategory.map((c) => c.name), datasets: [
      { label: '数量', data: d.byCategory.map((c) => c.c), backgroundColor: '#31565E' },
      { label: '原值(¥)', data: d.byCategory.map((c) => c.value), backgroundColor: '#A9762B', yAxisID: 'y1' }] },
      options: { scales: { y1: { position: 'right', grid: { drawOnChartArea: false } } } } });
    mk('ch-month', { type: 'line', data: { labels: d.monthly.map((m) => m.month), datasets: [{ label: '采购金额(¥)', data: d.monthly.map((m) => m.amount), borderColor: '#31565E', backgroundColor: 'rgba(49,86,94,.12)', fill: true, tension: .3 }] } });
  }

  // ---------- 我的待办 ----------
  async function renderTodo() {
    layout(topbar('我的待办') + `<div class="card" id="todo-body"><div class="empty">加载中...</div></div>`, '#/todo');
    let todos;
    try { todos = await api.get('/api/dashboard/todo'); } catch (e) { return toast(e.message, true); }
    const KIND = { usage: ['领用借用单', '#/usages'], purchase: ['采购入库单', '#/purchases'], change: ['资产变动单', '#/changes'] };
    document.getElementById('todo-body').innerHTML = `
      <h3>待处理单据（${todos.length}）</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>单据类型</th><th>单号</th><th>内容</th><th>当前节点</th><th>待办动作</th><th></th></tr></thead>
        <tbody>${todos.map((t) => `<tr>
          <td>${KIND[t.kind][0]}</td><td>${h(t.order_no)}</td><td>${h(t.title)}</td><td>${h(t.step)}</td><td>${badge(t.action, 'orange')}</td>
          <td><a class="btn sm primary" href="${KIND[t.kind][1]}?id=${t.id}">去处理</a></td></tr>`).join('') || '<tr><td colspan="6" class="empty">暂无待办 🎉</td></tr>'}</tbody>
      </table></div>`;
  }

  // ---------- 资产台账 ----------
  async function renderAssets(query) {
    const u = api.getUser();
    const isTeacher = u.role === 'teacher';
    layout(topbar(isTeacher ? '我的资产' : '资产台账', `
      ${hasR(u, 'admin') ? '<button class="btn primary" id="accrue-btn">计提本月折旧</button>' : ''}
      ${hasR(u, 'admin') ? '<button class="btn primary" id="add-asset-btn">+ 新增资产</button>' : ''}
      ${hasR(u, 'admin', 'head') ? '<button class="btn primary" id="initial-btn">📥 期初建档</button>' : ''}
      <button class="btn" id="toggle-view-btn">🖼 图册</button>
      ${hasR(u, 'admin', 'finance', 'principal', 'head') ? '<button class="btn" id="export-btn" title="按当前所选校区导出金蝶精斗云导入模板格式的台账">⬇ 导出台账</button>' : ''}`) + `
      ${isTeacher ? '' : `<div class="toolbar">
        <input id="f-q" placeholder="搜索名称/编号" value="${h(query.q || '')}">
        <select id="f-campus"><option value="">全部校区</option></select>
        <select id="f-status"><option value="">全部状态</option>${['在用','闲置','借用中','维修中','已报废'].map((s) => `<option ${query.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="f-source"><option value="">全部来源</option>${['期初建档','采购入库','手动新增'].map((s) => `<option ${query.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="btn" id="f-search">查询</button>
      </div>`}
      ${query.group_no ? `<div class="toolbar" style="background:var(--zx-dai-soft);border-radius:8px;padding:8px 12px">正在查看资产组：<b>${h(query.group_no)}</b> <a href="#/assets" class="btn sm">清除筛选</a></div>` : ''}
      <div class="card"><div class="table-wrap" id="assets-body"><div class="empty">加载中...</div></div></div>`, '#/assets');

    let viewMode = 'table';
    let campuses = [];
    try { campuses = await api.get('/api/dicts/campuses'); } catch (e) {}
    const campusSel = document.getElementById('f-campus');
    if (campusSel) {
      campusSel.innerHTML = '<option value="">全部校区</option>' + campuses.map((c) => `<option value="${c.id}" ${String(query.campus_id) === String(c.id) ? 'selected' : ''}>${h(c.name)}</option>`).join('');
      document.getElementById('f-search').onclick = () => {
        const q = document.getElementById('f-q').value;
        location.hash = `#/assets?q=${encodeURIComponent(q)}&campus_id=${campusSel.value}&status=${document.getElementById('f-status').value}&source=${encodeURIComponent(document.getElementById('f-source').value)}`;
      };
    }
    if (document.getElementById('accrue-btn')) document.getElementById('accrue-btn').onclick = async () => {
      if (!confirm('确认按「年限平均法（残值率5%）」计提本月折旧？\n当月新增资产自次月起计提，每资产每月仅计提一次。')) return;
      try { const r = await api.post('/api/assets/accrue'); toast(`已计提 ${r.accrued} 项资产（${r.month}）`); loadList(); } catch (e) { toast(e.message, true); }
    };
    if (document.getElementById('add-asset-btn')) document.getElementById('add-asset-btn').onclick = () => assetForm(null, campuses, loadList);
    if (document.getElementById('initial-btn')) document.getElementById('initial-btn').onclick = () => initialBookForm(campuses, loadList);
    document.getElementById('toggle-view-btn').onclick = () => { viewMode = viewMode === 'table' ? 'gallery' : 'table'; document.getElementById('toggle-view-btn').textContent = viewMode === 'table' ? '🖼 图册' : '☰ 表格'; loadList(); };
    if (document.getElementById('export-btn')) document.getElementById('export-btn').onclick = () => {
      const cid = campusSel ? campusSel.value : ''; // 按当前所选校区导出，全部校区则合表（使用部门列区分）
      downloadLedger(cid);
    };

    async function downloadLedger(campusId) {
      try {
        const res = await fetch('/api/assets/export?campus_id=' + encodeURIComponent(campusId || ''), { credentials: 'same-origin' });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error((d && d.error && d.error.message) || `导出失败（${res.status}）`);
        }
        const blob = await res.blob();
        const m = (res.headers.get('Content-Disposition') || '').match(/filename\*=UTF-8''([^;]+)/);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m ? decodeURIComponent(m[1]) : '固定资产台账.xlsx';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast('台账已导出');
      } catch (e) { toast(e.message, true); }
    }

    async function loadList() {
      const params = new URLSearchParams();
      if (query.q) params.set('q', query.q);
      if (query.campus_id) params.set('campus_id', query.campus_id);
      if (query.status) params.set('status', query.status);
      if (query.source) params.set('source', query.source);
      if (query.group_no) params.set('group_no', query.group_no);
      let rows;
      try { rows = await api.get('/api/assets?' + params.toString()); } catch (e) { return toast(e.message, true); }
      const srcBadge = (s) => s === '期初建档' ? badge('期初', 'orange') : '';
      const body = document.getElementById('assets-body');
      if (viewMode === 'gallery') {
        body.innerHTML = `<div class="gallery">${rows.map((a) => `
          <div class="g-item" data-id="${a.id}">
            ${a.photos[0] ? `<img class="thumb-lg" src="${h(a.photos[0])}">` : '<div class="thumb-lg" style="display:flex;align-items:center;justify-content:center;color:var(--zx-ink-3);font-size:32px">📦</div>'}
            <div class="g-cap"><b>${h(a.name)} ${srcBadge(a.source)}</b><span>${h(a.asset_no)}</span><br>${badge(a.status)}</div>
          </div>`).join('') || '<div class="empty">暂无资产</div>'}</div>`;
        body.querySelectorAll('.g-item').forEach((el) => el.onclick = () => assetDetail(el.dataset.id, loadList));
      } else {
        body.innerHTML = `<table><thead><tr>
          <th>照片</th><th>资产编号</th><th>名称</th>${isTeacher ? '' : '<th>校区</th><th>来源</th>'}<th>分类</th><th>地点</th><th>使用人</th><th>状态</th>${isTeacher ? '' : '<th>净值</th>'}<th></th>
          </tr></thead><tbody>${rows.map((a) => `<tr>
            <td>${a.photos[0] ? `<img class="thumb zoomable" src="${h(a.photos[0])}">` : '<span class="thumb"></span>'}</td>
            <td>${h(a.asset_no)}</td><td class="c-name">${h(a.name)}${a.group_no ? ` <span class="badge blue" title="资产组 ${h(a.group_no)}">组</span>` : ''}</td>${isTeacher ? '' : `<td>${h(a.campus_name)}</td><td>${srcBadge(a.source) || h(a.source || '')}</td>`}<td>${h(a.category_name)}</td>
            <td>${h(a.location_name || '—')}</td><td>${h(a.user_name || '—')}</td><td>${badge(a.status)}</td>
            ${isTeacher ? '' : `<td class="money">${a.net_value > 0 ? fmtMoney(a.net_value) : '—'}</td>`}
            <td><button class="btn sm" data-id="${a.id}">详情</button></td></tr>`).join('') || '<tr><td colspan="11" class="empty">暂无资产</td></tr>'}</tbody></table>`;
        body.querySelectorAll('button[data-id]').forEach((el) => el.onclick = () => assetDetail(el.dataset.id, loadList));
      }
    }
    loadList();
  }

  async function assetForm(asset, campuses, onDone) {
    const u = api.getUser();
    let cats = [], locs = [], users = [];
    try {
      [cats, locs, users] = await Promise.all([
        api.get('/api/dicts/categories'), api.get('/api/dicts/locations'),
        hasR(u, 'admin', 'finance', 'principal') ? api.get('/api/dicts/users') : Promise.resolve([]),
      ]);
    } catch (e) { return toast(e.message, true); }
    const m = openModal(`
      <h3>${asset ? '编辑资产' : '新增资产'}</h3>
      <div class="form-grid">
        <div class="form-row"><label>资产名称 *</label><input id="af-name" value="${h(asset?.name || '')}"></div>
        <div class="form-row"><label>所属校区 *</label><select id="af-campus" ${asset ? 'disabled' : ''}>${campuses.map((c) => `<option value="${c.id}" ${asset?.campus_id === c.id ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</select></div>
        <div class="form-row"><label>资产分类 *</label><select id="af-cat">${cats.map((c) => `<option value="${c.id}" data-life="${c.life_years}" ${asset?.category_id === c.id ? 'selected' : ''}>${h(c.name)}（折旧${c.life_years}年/残值${Math.round((c.salvage_rate != null ? c.salvage_rate : 0.05) * 100)}%）</option>`).join('')}</select></div>
        <div class="form-row"><label>存放地点</label><select id="af-loc"><option value="">—</option>${locs.map((l) => `<option value="${l.id}" data-campus="${l.campus_id}" ${asset?.location_id === l.id ? 'selected' : ''}>${h(l.campus_name)} / ${h(l.name)}</option>`).join('')}</select></div>
        <div class="form-row"><label>品牌（不知道可留空）</label><input id="af-brand" value="${h(asset?.brand || '')}" placeholder="如：爱普生 / 不详可留空"></div>
        <div class="form-row"><label>规格配置（可留空）</label><input id="af-spec" value="${h(asset?.spec || '')}" placeholder="如：i5/8G/256G、3匹柜机"></div>
        <div class="form-row"><label>原值（元，不清楚可留空）</label><input id="af-value" type="number" min="0" step="0.01" value="${asset?.original_value || ''}" placeholder="老资产填当前评估价值"></div>
        <div class="form-row"><label>购置日期（不清楚可留空）</label><input id="af-date" type="date" value="${h(asset?.purchase_date || (asset ? '' : new Date().toISOString().slice(0, 10)))}"></div>
        <div class="form-row"><label>折旧起始月</label><input id="af-depstart" type="month" value="${h(asset?.dep_start_month || (!asset ? nextYm() : ''))}" placeholder="默认次月"></div>
        <div class="form-row"><label>折旧月数</label><input id="af-depmonths" type="number" min="1" value="${asset?.dep_months || ''}" placeholder="默认分类年限×12"></div>
        <div class="form-row"><label>使用人</label><select id="af-user"><option value="">—</option>${users.map((x) => `<option value="${x.id}" ${asset?.user_id === x.id ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select></div>
        <div class="form-row"><label>状态</label><select id="af-status">${['在用','闲置','借用中','维修中','已报废'].map((s) => `<option ${asset?.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      </div>
      <div class="form-row"><label>资产照片（点 ➕ 上传，支持拍照 / 粘贴截图）</label><div class="photo-row" id="af-photos"></div></div>
      <div class="form-row"><label>备注</label><textarea id="af-remark" rows="2">${h(asset?.remark || '')}</textarea></div>
      <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="af-save">保存</button></div>`);
    const photos = photoUploader(m.querySelector('#af-photos'), asset?.photos || []);
    // 分类切换时提示默认折旧月数
    m.querySelector('#af-cat').onchange = (e) => {
      const life = e.target.selectedOptions[0]?.dataset.life;
      if (life) m.querySelector('#af-depmonths').placeholder = `默认 ${life * 12} 个月`;
    };
    m.querySelector('#af-save').onclick = async () => {
      const body = {
        name: m.querySelector('#af-name').value.trim(),
        campus_id: Number(m.querySelector('#af-campus').value),
        category_id: Number(m.querySelector('#af-cat').value),
        location_id: m.querySelector('#af-loc').value ? Number(m.querySelector('#af-loc').value) : null,
        user_id: m.querySelector('#af-user').value ? Number(m.querySelector('#af-user').value) : null,
        original_value: Number(m.querySelector('#af-value').value || 0),
        purchase_date: m.querySelector('#af-date').value || null,
        dep_start_month: m.querySelector('#af-depstart').value || null,
        dep_months: m.querySelector('#af-depmonths').value ? Number(m.querySelector('#af-depmonths').value) : null,
        status: m.querySelector('#af-status').value,
        photos: photos.getUrls(),
        brand: m.querySelector('#af-brand').value.trim(),
        spec: m.querySelector('#af-spec').value.trim(),
        remark: m.querySelector('#af-remark').value.trim(),
      };
      if (!body.name) return toast('请填写资产名称', true);
      try {
        if (asset) await api.put('/api/assets/' + asset.id, body);
        else { const r = await api.post('/api/assets', body); toast('已创建，编号：' + r.asset_no); }
        closeModal(); onDone && onDone();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ---------- 期初建档（存量资产批量补录） ----------
  async function initialBookForm(campuses, onDone) {
    const u = api.getUser();
    let cats = [], locs = [];
    try {
      [cats, locs] = await Promise.all([api.get('/api/dicts/categories'), api.get('/api/dicts/locations')]);
    } catch (e) { return toast(e.message, true); }
    // 校区负责人只能为本校区建档
    const myCampuses = hasR(u, 'admin') ? campuses.filter((c) => c.status === '启用') : campuses.filter((c) => c.id === u.campus_id);
    if (!myCampuses.length) return toast('无可建档校区', true);
    const m = openModal(`
      <h3>📥 期初建档 — 存量资产批量补录</h3>
      <div style="background:var(--zx-ochre-soft);border-radius:8px;padding:10px 12px;font-size:12.5px;color:var(--zx-ochre);margin-bottom:14px;line-height:1.7">
        适用于建校多年、采购信息已不可考的设备：只需填「名称 + 分类 + 数量」，拍照留档即可入账。<br>
        <b>老资产金额填当前评估价值</b>，购置日期可留空；折旧默认<b>次月</b>起按年限平均法计提（残值率 5%）。<br>
        同一行数量 N 会展开为 N 件独立资产并自动编为<b>同一资产组</b>（组内折旧时间一致）；桌椅板凳等建议同行录入。<br>
        老资产「折旧月数」按剩余可用时间填（如还可用 2 年填 24），留空则按分类年限。
      </div>
      <div class="form-grid">
        <div class="form-row"><label>建档校区 *</label><select id="ib-campus">${myCampuses.map((c) => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select></div>
        <div class="form-row"><label>默认状态</label><select id="ib-status">${['在用','闲置','维修中'].map((s) => `<option>${s}</option>`).join('')}</select></div>
      </div>
      <h3>建档明细 <button class="btn sm primary" id="ib-add-row">+ 添加一行</button></h3>
      <div id="ib-rows"></div>
      <div class="modal-actions">
        <button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button>
        <button class="btn primary" id="ib-save">提交建档</button>
      </div>`);
    const rowsBox = m.querySelector('#ib-rows');
    const photoUps = [];
    function addRow() {
      const idx = rowsBox.children.length;
      const div = document.createElement('div');
      div.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px;background:var(--zx-paper)';
      div.innerHTML = `
        <div class="form-grid">
          <div class="form-row"><label>名称 *（如：一体机）</label><input data-k="name" placeholder="品牌不详可只写名称"></div>
          <div class="form-row"><label>分类 *</label><select data-k="category_id">${cats.map((c) => `<option value="${c.id}">${h(c.name)}（${c.life_years}年）</option>`).join('')}</select></div>
          <div class="form-row"><label>数量</label><input data-k="qty" type="number" min="1" value="1"></div>
          <div class="form-row"><label>存放地点（可空）</label><select data-k="location_id"><option value="">—</option>${locs.map((l) => `<option value="${l.id}" data-campus="${l.campus_id}">${h(l.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label>品牌（可空）</label><input data-k="brand" placeholder="不知道就留空"></div>
          <div class="form-row"><label>规格配置（可空）</label><input data-k="spec" placeholder="如：55寸 / 1.5匹"></div>
          <div class="form-row"><label>单件评估价值（可空）</label><input data-k="original_value" type="number" min="0" step="0.01" placeholder="老资产填当前估值"></div>
          <div class="form-row"><label>购置日期（可空）</label><input data-k="purchase_date" type="date"></div>
          <div class="form-row"><label>折旧月数（可空）</label><input data-k="dep_months" type="number" min="1" placeholder="老资产填剩余可用月数"></div>
        </div>
        <div class="form-row"><label>照片（点 ➕ 上传，支持拍照/粘贴；同行每件共用）</label><div class="photo-row" data-k="photos"></div></div>`;
      rowsBox.appendChild(div);
      photoUps[idx] = photoUploader(div.querySelector('[data-k=photos]'), []);
      // 校区切换时联动地点可选项
      const campusSel = m.querySelector('#ib-campus');
      const filterLocs = () => {
        const cid = campusSel.value;
        div.querySelectorAll('[data-k=location_id] option[data-campus]').forEach((op) => {
          op.style.display = op.dataset.campus === cid ? '' : 'none';
        });
        const cur = div.querySelector('[data-k=location_id]');
        const selOp = cur.selectedOptions[0];
        if (selOp && selOp.dataset.campus && selOp.dataset.campus !== cid) cur.value = '';
      };
      campusSel.onchange = () => Array.from(rowsBox.children).forEach((row) => row.dispatchEvent(new Event('filter-locs')));
      div.addEventListener('filter-locs', filterLocs);
      filterLocs();
    }
    addRow();
    m.querySelector('#ib-add-row').onclick = addRow;
    m.querySelector('#ib-save').onclick = async () => {
      const defStatus = m.querySelector('#ib-status').value;
      const items = Array.from(rowsBox.children).map((div, i) => ({
        name: div.querySelector('[data-k=name]').value.trim(),
        category_id: Number(div.querySelector('[data-k=category_id]').value),
        qty: Number(div.querySelector('[data-k=qty]').value || 1),
        location_id: div.querySelector('[data-k=location_id]').value ? Number(div.querySelector('[data-k=location_id]').value) : null,
        brand: div.querySelector('[data-k=brand]').value.trim() || null,
        spec: div.querySelector('[data-k=spec]').value.trim() || null,
        original_value: Number(div.querySelector('[data-k=original_value]').value || 0),
        purchase_date: div.querySelector('[data-k=purchase_date]').value || null,
        dep_months: div.querySelector('[data-k=dep_months]').value ? Number(div.querySelector('[data-k=dep_months]').value) : null,
        status: defStatus,
        photos: photoUps[i] ? photoUps[i].getUrls() : [],
      }));
      if (items.some((x) => !x.name)) return toast('请填写所有行的名称', true);
      const totalQty = items.reduce((s, x) => s + x.qty, 0);
      if (!confirm(`将建档 ${items.length} 行，共 ${totalQty} 件资产，确认提交？`)) return;
      try {
        const r = await api.post('/api/assets/initial', { campus_id: Number(m.querySelector('#ib-campus').value), items });
        toast(`建档成功，共生成 ${r.created_count} 件资产`);
        closeModal(); onDone && onDone();
      } catch (e) { toast(e.message, true); }
    };
  }

  async function assetDetail(id, onChange) {
    let a;
    try { a = await api.get('/api/assets/' + id); } catch (e) { return toast(e.message, true); }
    const u = api.getUser();
    const m = openModal(`
      <h3>${h(a.name)} ${badge(a.status)}</h3>
      <div class="photo-row" style="margin-bottom:12px">${a.photos.map((p) => `<img class="zoomable" src="${h(p)}">`).join('') || '<span style="color:var(--zx-ink-3)">暂无照片</span>'}</div>
      <div class="table-wrap"><table><tbody>
        <tr><th>资产编号</th><td>${h(a.asset_no)}</td></tr>
        <tr><th>所属校区</th><td>${h(a.campus_name)}</td></tr>
        <tr><th>分类</th><td>${h(a.category_name)}</td></tr>
        <tr><th>入账来源</th><td>${a.source === '期初建档' ? badge('期初建档', 'orange') : h(a.source || '手动新增')}</td></tr>
        <tr><th>品牌</th><td>${h(a.brand || '待补录')}</td></tr>
        <tr><th>规格配置</th><td>${h(a.spec || '待补录')}</td></tr>
        <tr><th>存放地点</th><td>${h(a.location_name || '—')}</td></tr>
        <tr><th>使用人</th><td>${h(a.user_name || '—')}</td></tr>
        ${a.original_value !== undefined ? `<tr><th>原值</th><td class="money">${a.original_value > 0 ? fmtMoney(a.original_value) : '待补录'}</td></tr>
        <tr><th>累计折旧</th><td class="money">${fmtMoney(a.acc_depreciation)}</td></tr>
        <tr><th>净值</th><td class="money">${a.net_value > 0 ? fmtMoney(a.net_value) : '待补录'}</td></tr>` : ''}
        ${a.monthly_dep !== undefined && a.original_value > 0 ? `
        <tr><th>折旧起始月</th><td>${a.dep_start_month ? h(a.dep_start_month) : '暂不计提'}</td></tr>
        <tr><th>折旧月数</th><td>${a.dep_months || '—'} 个月（残值率 ${Math.round((a.salvage_rate != null ? a.salvage_rate : 0.05) * 100)}%）</td></tr>
        <tr><th>月折旧额</th><td class="money">${fmtMoney(a.monthly_dep)}</td></tr>
        <tr><th>应计提总额</th><td class="money">${fmtMoney(a.dep_base)}</td></tr>
        <tr><th>剩余计提月数</th><td>${a.remaining_months != null ? a.remaining_months + ' 个月' : '—'}</td></tr>` : ''}
        ${a.group_no ? `<tr><th>资产组</th><td>${h(a.group_no)}（同组 ${a.group_count || 1} 件，折旧时间一致） <button class="btn sm" id="ad-group">查看同组</button></td></tr>` : ''}
        <tr><th>购置日期</th><td>${a.purchase_date ? fmtDate(a.purchase_date) : '待补录'}</td></tr>
        <tr><th>备注</th><td>${h(a.remark || '—')}</td></tr>
      </tbody></table></div>
      <h3 style="margin-top:16px">领用借用历史</h3>
      <div class="table-wrap"><table><thead><tr><th>单号</th><th>类型</th><th>使用人</th><th>状态</th><th>时间</th></tr></thead>
      <tbody>${a.usages.map((x) => `<tr><td>${h(x.order_no)}</td><td>${x.type}</td><td>${h(x.user_name)}</td><td>${badge(x.status, x.status === '已归还' ? 'green' : 'blue')}</td><td>${fmtDate(x.created_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无记录</td></tr>'}</tbody></table></div>
      <h3 style="margin-top:16px">变动历史</h3>
      <div class="table-wrap"><table><thead><tr><th>单号</th><th>类型</th><th>调出</th><th>调入</th><th>状态</th><th>时间</th></tr></thead>
      <tbody>${a.changes.map((x) => `<tr><td>${h(x.order_no)}</td><td>${x.type}</td><td>${h(x.from_campus_name)}</td><td>${h(x.to_campus_name || '—')}</td><td>${badge(x.status, x.status === '已完成' ? 'green' : x.status === '已拒绝' ? 'red' : 'orange')}</td><td>${fmtDate(x.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">暂无记录</td></tr>'}</tbody></table></div>
      <div class="modal-actions">
        <button class="btn" onclick="document.getElementById('modal-mask').remove()">关闭</button>
        ${hasR(u, 'admin') ? '<button class="btn primary" id="ad-edit">编辑</button>' : ''}
        ${hasR(u, 'admin', 'head', 'teacher') && ['在用', '闲置'].includes(a.status) ? '<button class="btn success" id="ad-apply">申请领用/借用</button>' : ''}
        ${hasR(u, 'admin', 'head') && a.status !== '已报废' ? '<button class="btn" id="ad-change">发起变动</button>' : ''}
        ${u.role === 'teacher' && a.user_id === u.id && a.status !== '已报废' ? '<button class="btn" id="ad-repair">报修</button>' : ''}
      </div>`);
    if (m.querySelector('#ad-edit')) m.querySelector('#ad-edit').onclick = async () => { const cs = await api.get('/api/dicts/campuses'); assetForm(a, cs, onChange); };
    if (m.querySelector('#ad-group')) m.querySelector('#ad-group').onclick = () => { closeModal(); location.hash = `#/assets?group_no=${encodeURIComponent(a.group_no)}`; };
    if (m.querySelector('#ad-apply')) m.querySelector('#ad-apply').onclick = () => usageForm(a, onChange);
    if (m.querySelector('#ad-change')) m.querySelector('#ad-change').onclick = () => changeForm(a, onChange);
    if (m.querySelector('#ad-repair')) m.querySelector('#ad-repair').onclick = () => changeForm(a, onChange, '维修');
  }

  window.__assetDetail = assetDetail;

  // ---------- 领用借用 ----------
  async function usageForm(asset, onDone) {
    const m = openModal(`
      <h3>申请领用/借用 — ${h(asset.name)}（${h(asset.asset_no)}）</h3>
      <div class="form-row"><label>类型 *</label><select id="uf-type"><option>领用</option><option>借用</option></select></div>
      <div class="form-row"><label>预计归还日期（借用必填）</label><input id="uf-return" type="date"></div>
      <div class="form-row"><label>事由</label><textarea id="uf-reason" rows="2"></textarea></div>
      <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="uf-save">提交申请</button></div>`);
    m.querySelector('#uf-save').onclick = async () => {
      const type = m.querySelector('#uf-type').value;
      const expected_return = m.querySelector('#uf-return').value;
      if (type === '借用' && !expected_return) return toast('借用请填写预计归还日期', true);
      try {
        const r = await api.post('/api/usages', { asset_id: asset.id, type, expected_return: expected_return || null, reason: m.querySelector('#uf-reason').value.trim() });
        toast('已提交，单号：' + r.order_no); closeModal(); onDone && onDone();
      } catch (e) { toast(e.message, true); }
    };
  }

  async function renderUsages(query) {
    const u = api.getUser();
    layout(topbar('领用借用单') + `<div class="card"><div class="table-wrap" id="usages-body"><div class="empty">加载中...</div></div></div>`, '#/usages');
    let rows;
    try { rows = await api.get('/api/usages'); } catch (e) { return toast(e.message, true); }
    const body = document.getElementById('usages-body');
    body.innerHTML = `<table><thead><tr>
      <th>单号</th><th>资产</th><th>校区</th><th>使用人</th><th>类型</th><th>预计归还</th><th>状态</th><th>申请时间</th><th></th>
      </tr></thead><tbody>${rows.map((o) => `<tr ${query.id === String(o.id) ? 'style="background:var(--zx-ochre-soft)"' : ''}>
        <td>${h(o.order_no)}</td><td>${h(o.asset_name)}</td><td>${h(o.campus_name)}</td><td>${h(o.user_name)}</td>
        <td>${o.type}</td><td>${fmtDate(o.expected_return)}</td>
        <td>${badge(o.status, { '待审批': 'orange', '已批准': 'blue', '已执行': 'green', '已拒绝': 'red', '已归还': 'gray' }[o.status])}</td>
        <td>${fmtDate(o.created_at)}</td><td><button class="btn sm" data-id="${o.id}">详情</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">暂无单据</td></tr>'}</tbody></table>`;
    body.querySelectorAll('button[data-id]').forEach((el) => el.onclick = () => usageDetail(el.dataset.id));
  }

  async function usageDetail(id) {
    let o;
    try { o = await api.get('/api/usages/' + id); } catch (e) { return toast(e.message, true); }
    const u = api.getUser();
    const canApprove = (hasR(u, 'admin') || (u.role === 'head' && u.campus_id === o.campus_id)) && o.status === '待审批';
    const canExecute = hasR(u, 'admin') && o.status === '已批准';
    const canReturn = o.status === '已执行' && (u.role !== 'teacher' || o.user_id === u.id || o.created_by === u.id) && (u.role !== 'head' || u.campus_id === o.campus_id);
    const m = openModal(`
      <h3>领用借用单 ${h(o.order_no)}</h3>
      <div class="table-wrap"><table><tbody>
        <tr><th>资产</th><td>${h(o.asset_name)}（${h(o.asset_no)}）</td></tr>
        <tr><th>校区</th><td>${h(o.campus_name)}</td></tr>
        <tr><th>使用人</th><td>${h(o.user_name)}</td></tr>
        <tr><th>类型</th><td>${o.type}</td></tr>
        <tr><th>预计归还</th><td>${fmtDate(o.expected_return)}</td></tr>
        <tr><th>事由</th><td>${h(o.reason || '—')}</td></tr>
        <tr><th>状态</th><td>${badge(o.status, 'blue')}</td></tr>
      </tbody></table></div>
      ${approvalTimeline(o.approvals)}
      <div class="modal-actions">
        <button class="btn" onclick="document.getElementById('modal-mask').remove()">关闭</button>
        ${canApprove ? '<button class="btn danger" id="ud-reject">拒绝</button><button class="btn primary" id="ud-approve">通过</button>' : ''}
        ${canExecute ? '<button class="btn success" id="ud-execute">行政执行（回写台账）</button>' : ''}
        ${canReturn ? '<button class="btn primary" id="ud-return">归还</button>' : ''}
      </div>`);
    const act = async (url, body) => { try { await api.post(url, body); toast('操作成功'); closeModal(); renderUsages({}); } catch (e) { toast(e.message, true); } };
    if (m.querySelector('#ud-approve')) m.querySelector('#ud-approve').onclick = () => act(`/api/usages/${o.id}/approve`, { action: '通过' });
    if (m.querySelector('#ud-reject')) m.querySelector('#ud-reject').onclick = () => { const c = prompt('拒绝原因：'); if (c !== null) act(`/api/usages/${o.id}/approve`, { action: '拒绝', comment: c }); };
    if (m.querySelector('#ud-execute')) m.querySelector('#ud-execute').onclick = () => act(`/api/usages/${o.id}/execute`, {});
    if (m.querySelector('#ud-return')) m.querySelector('#ud-return').onclick = () => act(`/api/usages/${o.id}/return`, {});
  }

  function approvalTimeline(approvals) {
    if (!approvals || !approvals.length) return '';
    return `<h3 style="margin-top:16px">审批记录</h3><div class="timeline">${approvals.map((a) => `
      <div class="t-item"><b>${h(a.approver_name)}</b> ${h(a.action)}（${h(a.step)}）${a.comment ? '：' + h(a.comment) : ''}
      <div class="t-meta">${h(a.created_at)}</div></div>`).join('')}</div>`;
  }

  // ---------- 采购入库 ----------
  async function renderPurchases(query) {
    const u = api.getUser();
    layout(topbar('采购入库单', hasR(u, 'admin') ? '<button class="btn primary" id="add-po-btn">+ 新建入库单</button>' : '') +
      `<div class="card"><div class="table-wrap" id="po-body"><div class="empty">加载中...</div></div></div>`, '#/purchases');
    if (document.getElementById('add-po-btn')) document.getElementById('add-po-btn').onclick = () => purchaseForm();
    let rows;
    try { rows = await api.get('/api/purchases'); } catch (e) { return toast(e.message, true); }
    const body = document.getElementById('po-body');
    body.innerHTML = `<table><thead><tr><th>单号</th><th>校区</th><th>到货日期</th><th>验收人</th><th>状态</th><th>创建时间</th><th></th></tr></thead>
      <tbody>${rows.map((o) => `<tr ${query.id === String(o.id) ? 'style="background:var(--zx-ochre-soft)"' : ''}>
        <td>${h(o.order_no)}</td><td>${h(o.campus_name)}</td><td>${fmtDate(o.arrive_date)}</td><td>${h(o.inspector_name || '—')}</td>
        <td>${badge(o.status, { '待验收': 'orange', '验收通过': 'green', '验收不通过': 'red' }[o.status])}</td>
        <td>${fmtDate(o.created_at)}</td><td><button class="btn sm" data-id="${o.id}">详情</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">暂无单据</td></tr>'}</tbody></table>`;
    body.querySelectorAll('button[data-id]').forEach((el) => el.onclick = () => purchaseDetail(el.dataset.id));
  }

  async function purchaseForm() {
    let campuses = [], cats = [];
    try { [campuses, cats] = await Promise.all([api.get('/api/dicts/campuses'), api.get('/api/dicts/categories')]); } catch (e) { return toast(e.message, true); }
    const items = [];
    const m = openModal(`
      <h3>新建采购入库单</h3>
      <div class="form-grid">
        <div class="form-row"><label>所属校区 *</label><select id="po-campus">${campuses.map((c) => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select></div>
        <div class="form-row"><label>到货日期</label><input id="po-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <h3>采购明细 <button class="btn sm primary" id="po-add-item">+ 添加一行</button></h3>
      <div id="po-items"></div>
      <div class="form-row" style="margin-top:12px"><label>备注</label><textarea id="po-remark" rows="2"></textarea></div>
      <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="po-save">提交入库单</button></div>`);
    const itemsBox = m.querySelector('#po-items');
    const photoUps = [];
    function addItem() {
      const idx = items.length;
      items.push({});
      const div = document.createElement('div');
      div.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px';
      div.innerHTML = `
        <div class="form-grid">
          <div class="form-row"><label>资产名称 *</label><input data-k="name"></div>
          <div class="form-row"><label>分类 *</label><select data-k="category_id">${cats.map((c) => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label>数量 *</label><input data-k="qty" type="number" min="1" value="1"></div>
          <div class="form-row"><label>单价（元）*</label><input data-k="unit_price" type="number" min="0" step="0.01" value="0"></div>
        </div>
        <div class="form-row"><label>实物照片（点 ➕ 上传，可拍照/粘贴）</label><div class="photo-row" data-k="photos"></div></div>`;
      itemsBox.appendChild(div);
      photoUps[idx] = photoUploader(div.querySelector('[data-k=photos]'), []);
    }
    addItem();
    m.querySelector('#po-add-item').onclick = addItem;
    m.querySelector('#po-save').onclick = async () => {
      const itemData = Array.from(itemsBox.children).map((div, i) => ({
        name: div.querySelector('[data-k=name]').value.trim(),
        category_id: Number(div.querySelector('[data-k=category_id]').value),
        qty: Number(div.querySelector('[data-k=qty]').value || 1),
        unit_price: Number(div.querySelector('[data-k=unit_price]').value || 0),
        photos: photoUps[i].getUrls(),
      }));
      if (itemData.some((x) => !x.name)) return toast('请填写所有明细的资产名称', true);
      try {
        const r = await api.post('/api/purchases', { campus_id: Number(m.querySelector('#po-campus').value), arrive_date: m.querySelector('#po-date').value, remark: m.querySelector('#po-remark').value.trim(), items: itemData });
        toast('已提交，单号：' + r.order_no); closeModal(); renderPurchases({});
      } catch (e) { toast(e.message, true); }
    };
  }

  async function purchaseDetail(id) {
    let o;
    try { o = await api.get('/api/purchases/' + id); } catch (e) { return toast(e.message, true); }
    const u = api.getUser();
    const canInspect = hasR(u, 'admin') && o.status === '待验收';
    const m = openModal(`
      <h3>入库单 ${h(o.order_no)} ${badge(o.status, { '待验收': 'orange', '验收通过': 'green', '验收不通过': 'red' }[o.status])}</h3>
      <div class="table-wrap"><table><tbody>
        <tr><th>所属校区</th><td>${h(o.campus_name)}</td></tr>
        <tr><th>到货日期</th><td>${fmtDate(o.arrive_date)}</td></tr>
        <tr><th>验收人</th><td>${h(o.inspector_name || '—')}</td></tr>
        <tr><th>备注</th><td>${h(o.remark || '—')}</td></tr>
      </tbody></table></div>
      <h3 style="margin-top:14px">采购明细（合计 ${fmtMoney(o.items.reduce((s, i) => s + i.qty * i.unit_price, 0))}）</h3>
      ${o.items.map((it) => `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">
        <b>${h(it.name)}</b> · ${h(it.category_name)} · ×${it.qty} · <span class="money">${fmtMoney(it.unit_price)}/件</span>
        <div class="photo-row">${it.photos.map((p) => `<img class="zoomable" src="${h(p)}">`).join('')}</div></div>`).join('')}
      <div class="modal-actions">
        <button class="btn" onclick="document.getElementById('modal-mask').remove()">关闭</button>
        ${canInspect ? '<button class="btn danger" id="po-reject">验收不通过</button><button class="btn success" id="po-pass">验收通过（生成台账）</button>' : ''}
      </div>`);
    const act = async (result) => {
      try {
        const r = await api.post(`/api/purchases/${o.id}/inspect`, { result });
        toast(result === '验收通过' ? `已生成 ${r.generated_assets.length} 条台账` : '已标记验收不通过');
        closeModal(); renderPurchases({});
      } catch (e) { toast(e.message, true); }
    };
    if (m.querySelector('#po-pass')) m.querySelector('#po-pass').onclick = () => act('验收通过');
    if (m.querySelector('#po-reject')) m.querySelector('#po-reject').onclick = () => { if (confirm('确认验收不通过？')) act('验收不通过'); };
  }

  // ---------- 资产变动 ----------
  async function changeForm(asset, onDone, fixedType) {
    let campuses = [], locs = [], users = [];
    try { [campuses, locs, users] = await Promise.all([api.get('/api/dicts/campuses'), api.get('/api/dicts/locations'),
      hasR(api.getUser(), 'admin') ? api.get('/api/dicts/users') : Promise.resolve([])]); } catch (e) { return toast(e.message, true); }
    const isTeacher = api.getUser().role === 'teacher';
    const m = openModal(`
      <h3>发起变动 — ${h(asset.name)}（${h(asset.asset_no)}）</h3>
      <div class="form-row"><label>变动类型 *</label><select id="cf-type" ${fixedType ? 'disabled' : ''}>
        ${['维修', '调拨', '报废'].filter((t) => !isTeacher || t !== '调拨').map((t) => `<option ${fixedType === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div id="cf-extra"></div>
      <div class="form-row"><label>费用（元，维修/报废填写）</label><input id="cf-fee" type="number" min="0" step="0.01" value="0"></div>
      <div class="form-row"><label>原因说明</label><textarea id="cf-reason" rows="2"></textarea></div>
      <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="cf-save">提交</button></div>`);
    const extra = m.querySelector('#cf-extra');
    const renderExtra = () => {
      if (m.querySelector('#cf-type').value === '调拨') {
        extra.innerHTML = `
          <div class="form-grid">
            <div class="form-row"><label>目标校区 *</label><select id="cf-to">${campuses.filter((c) => c.id !== asset.campus_id && c.status === '启用').map((c) => `<option value="${c.id}">${h(c.name)}</option>`).join('')}<option value="${asset.campus_id}">本校区内调拨</option></select></div>
            <div class="form-row"><label>目标地点</label><select id="cf-loc"><option value="">—</option>${locs.map((l) => `<option value="${l.id}">${h(l.campus_name)} / ${h(l.name)}</option>`).join('')}</select></div>
          </div>
          ${users.length ? `<div class="form-row"><label>接收人</label><select id="cf-receiver"><option value="">—</option>${users.map((x) => `<option value="${x.id}">${h(x.name)}（${h(x.campus_name || '')}）</option>`).join('')}</select></div>` : ''}`;
      } else extra.innerHTML = '';
    };
    m.querySelector('#cf-type').onchange = renderExtra;
    renderExtra();
    m.querySelector('#cf-save').onclick = async () => {
      const type = m.querySelector('#cf-type').value;
      const body = { asset_id: asset.id, type, fee: Number(m.querySelector('#cf-fee').value || 0), reason: m.querySelector('#cf-reason').value.trim() };
      if (type === '调拨') {
        body.to_campus_id = Number(m.querySelector('#cf-to').value);
        const loc = m.querySelector('#cf-loc'); if (loc && loc.value) body.to_location_id = Number(loc.value);
        const rv = m.querySelector('#cf-receiver'); if (rv && rv.value) body.receiver_id = Number(rv.value);
      }
      try {
        const r = await api.post('/api/changes', body);
        toast('已提交，单号：' + r.order_no); closeModal(); onDone && onDone();
      } catch (e) { toast(e.message, true); }
    };
  }

  async function renderChanges(query) {
    layout(topbar('资产变动单') + `<div class="card"><div class="table-wrap" id="ch-body"><div class="empty">加载中...</div></div></div>`, '#/changes');
    let rows;
    try { rows = await api.get('/api/changes'); } catch (e) { return toast(e.message, true); }
    const STEP_NAMES = { head_from: '调出校区负责人审批', head_to: '调入校区负责人审批', finance: '财务审核', admin_exec: '行政执行', done: '已结束' };
    document.getElementById('ch-body').innerHTML = `<table><thead><tr>
      <th>单号</th><th>资产</th><th>类型</th><th>调出校区</th><th>调入校区</th><th>状态</th><th>当前节点</th><th>发起时间</th><th></th>
      </tr></thead><tbody>${rows.map((o) => `<tr ${query.id === String(o.id) ? 'style="background:var(--zx-ochre-soft)"' : ''}>
        <td>${h(o.order_no)}</td><td>${h(o.asset_name)}</td><td>${badge(o.type, 'blue')}</td>
        <td>${h(o.from_campus_name)}</td><td>${h(o.to_campus_name || '—')}</td>
        <td>${badge(o.status, { '待审批': 'orange', '已完成': 'green', '已拒绝': 'red' }[o.status])}</td>
        <td>${STEP_NAMES[o.current_step] || o.current_step}</td><td>${fmtDate(o.created_at)}</td>
        <td><button class="btn sm" data-id="${o.id}">详情</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">暂无单据</td></tr>'}</tbody></table>`;
    document.querySelectorAll('#ch-body button[data-id]').forEach((el) => el.onclick = () => changeDetail(el.dataset.id));
  }

  async function changeDetail(id) {
    let o;
    try { o = await api.get('/api/changes/' + id); } catch (e) { return toast(e.message, true); }
    const u = api.getUser();
    let canAct = false;
    if (o.status === '待审批') {
      if (o.current_step === 'head_from') canAct = hasR(u, 'admin') || (u.role === 'head' && u.campus_id === o.from_campus_id);
      else if (o.current_step === 'head_to') canAct = hasR(u, 'admin') || (u.role === 'head' && u.campus_id === o.to_campus_id);
      else if (o.current_step === 'finance') canAct = hasR(u, 'finance');
      else if (o.current_step === 'admin_exec') canAct = hasR(u, 'admin');
    }
    const canRepairDone = hasR(u, 'admin') && o.type === '维修' && o.status === '已完成';
    const m = openModal(`
      <h3>变动单 ${h(o.order_no)} ${badge(o.type, 'blue')}</h3>
      <div class="table-wrap"><table><tbody>
        <tr><th>资产</th><td>${h(o.asset_name)}（${h(o.asset_no)}）</td></tr>
        <tr><th>调出校区</th><td>${h(o.from_campus_name)}</td></tr>
        ${o.type === '调拨' ? `<tr><th>调入校区</th><td>${h(o.to_campus_name || '—')}${o.from_campus_id !== o.to_campus_id ? ' ' + badge('跨校区', 'orange') : ''}</td></tr>
        <tr><th>目标地点</th><td>${h(o.to_location_name || '—')}</td></tr>
        <tr><th>接收人</th><td>${h(o.receiver_name || '—')}</td></tr>` : ''}
        <tr><th>费用</th><td class="money">${fmtMoney(o.fee)}</td></tr>
        <tr><th>原因</th><td>${h(o.reason || '—')}</td></tr>
        <tr><th>状态</th><td>${badge(o.status, { '待审批': 'orange', '已完成': 'green', '已拒绝': 'red' }[o.status])}</td></tr>
      </tbody></table></div>
      ${approvalTimeline(o.approvals)}
      <div class="modal-actions">
        <button class="btn" onclick="document.getElementById('modal-mask').remove()">关闭</button>
        ${canAct ? `<button class="btn danger" id="cd-reject">拒绝</button><button class="btn primary" id="cd-approve">${o.current_step === 'admin_exec' ? '执行（回写台账）' : '通过'}</button>` : ''}
        ${canRepairDone ? '<button class="btn success" id="cd-repair-done">维修完成（恢复在用）</button>' : ''}
      </div>`);
    const act = async (body) => { try { await api.post(`/api/changes/${o.id}/approve`, body); toast('操作成功'); closeModal(); renderChanges({}); } catch (e) { toast(e.message, true); } };
    if (m.querySelector('#cd-approve')) m.querySelector('#cd-approve').onclick = () => act({ action: '通过' });
    if (m.querySelector('#cd-reject')) m.querySelector('#cd-reject').onclick = () => { const c = prompt('拒绝原因：'); if (c !== null) act({ action: '拒绝', comment: c }); };
    if (m.querySelector('#cd-repair-done')) m.querySelector('#cd-repair-done').onclick = async () => {
      try { await api.post(`/api/changes/${o.id}/repair-done`, {}); toast('资产已恢复在用'); closeModal(); renderChanges({}); } catch (e) { toast(e.message, true); }
    };
  }

  // ---------- 盘点 ----------
  async function renderInventory() {
    const u = api.getUser();
    layout(topbar('资产盘点', hasR(u, 'admin', 'head') ? '<button class="btn primary" id="add-inv-btn">+ 发起盘点</button>' : '') +
      `<div class="card"><div class="table-wrap" id="inv-body"><div class="empty">加载中...</div></div></div>`, '#/inventory');
    if (document.getElementById('add-inv-btn')) document.getElementById('add-inv-btn').onclick = async () => {
      const campuses = await api.get('/api/dicts/campuses');
      const myCampuses = hasR(u, 'admin') ? campuses : campuses.filter((c) => c.id === u.campus_id);
      const m = openModal(`
        <h3>发起盘点任务</h3>
        <div class="form-row"><label>任务名称 *</label><input id="iv-name" placeholder="如：2026年10月金城校区盘点"></div>
        <div class="form-row"><label>盘点校区 *</label><select id="iv-campus">${myCampuses.map((c) => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select></div>
        <div class="form-row"><label>截止日期</label><input id="iv-deadline" type="date"></div>
        <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="iv-save">发起（自动生成明细）</button></div>`);
      m.querySelector('#iv-save').onclick = async () => {
        const name = m.querySelector('#iv-name').value.trim();
        if (!name) return toast('请填写任务名称', true);
        try {
          const r = await api.post('/api/inventory', { name, campus_id: Number(m.querySelector('#iv-campus').value), deadline: m.querySelector('#iv-deadline').value || null });
          toast(`已发起，自动生成 ${r.total} 条盘点明细`); closeModal(); renderInventory();
        } catch (e) { toast(e.message, true); }
      };
    };
    let rows;
    try { rows = await api.get('/api/inventory'); } catch (e) { return toast(e.message, true); }
    document.getElementById('inv-body').innerHTML = `<table><thead><tr>
      <th>任务名称</th><th>校区</th><th>进度</th><th>差异</th><th>截止日期</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows.map((t) => `<tr>
        <td>${h(t.name)}</td><td>${h(t.campus_name)}</td>
        <td><div class="progress" style="width:120px"><div style="width:${t.total ? Math.round(t.checked / t.total * 100) : 0}%"></div></div><span style="font-size:12px;color:var(--text-2)">${t.checked}/${t.total}</span></td>
        <td>${t.diff > 0 ? badge(t.diff + ' 项差异', 'red') : '—'}</td>
        <td>${fmtDate(t.deadline)}</td><td>${badge(t.status, t.status === '进行中' ? 'orange' : 'green')}</td>
        <td><button class="btn sm" data-id="${t.id}">进入盘点</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">暂无盘点任务</td></tr>'}</tbody></table>`;
    document.querySelectorAll('#inv-body button[data-id]').forEach((el) => el.onclick = () => inventoryDetail(el.dataset.id));
  }

  async function inventoryDetail(id) {
    let t;
    try { t = await api.get('/api/inventory/' + id); } catch (e) { return toast(e.message, true); }
    const u = api.getUser();
    const canCheck = t.status === '进行中' && (hasR(u, 'admin') || u.campus_id === t.campus_id);
    const canFinish = canCheck && hasR(u, 'admin', 'head');
    const m = openModal(`
      <h3>${h(t.name)} ${badge(t.status, t.status === '进行中' ? 'orange' : 'green')}</h3>
      <div style="color:var(--text-2);font-size:13px;margin-bottom:12px">${h(t.campus_name)} · 截止 ${fmtDate(t.deadline)} · 已核对 ${t.items.filter((i) => i.result).length}/${t.items.length}</div>
      <div class="progress" style="margin-bottom:14px"><div style="width:${t.items.length ? Math.round(t.items.filter((i) => i.result).length / t.items.length * 100) : 0}%"></div></div>
      <div style="max-height:50vh;overflow-y:auto" id="inv-items"></div>
      <div class="modal-actions">
        <button class="btn" onclick="document.getElementById('modal-mask').remove()">关闭</button>
        ${canFinish ? '<button class="btn primary" id="iv-finish">完成盘点</button>' : ''}
      </div>`);
    const box = m.querySelector('#inv-items');
    function renderItems() {
      box.innerHTML = t.items.map((it) => `
        <div class="inv-item">
          ${it.asset_photos[0] ? `<img class="thumb zoomable" src="${h(it.asset_photos[0])}">` : '<span class="thumb"></span>'}
          <div class="info"><b>${h(it.asset_name)}</b><div class="meta">${h(it.asset_no)} · ${h(it.location_name || '—')} · 使用人:${h(it.user_name || '—')} · 台账状态:${it.asset_status}</div>
            ${it.result ? `<div style="margin-top:4px">${badge(it.result, it.result === '一致' ? 'green' : 'red')} <span style="font-size:12px;color:var(--text-2)">${h(it.checked_by_name || '')} ${h(it.checked_at || '')}</span></div>
              ${it.photos.length ? `<div class="photo-row">${it.photos.map((p) => `<img class="zoomable" src="${h(p)}">`).join('')}</div>` : ''}` : ''}
          </div>
          ${canCheck && !it.result ? `<div class="ops"><button class="btn sm primary" data-check="${it.id}">核对</button></div>` : ''}
        </div>`).join('') || '<div class="empty">无明细</div>';
      box.querySelectorAll('[data-check]').forEach((el) => el.onclick = () => checkItem(el.dataset.check));
    }
    function checkItem(itemId) {
      const it = t.items.find((x) => String(x.id) === String(itemId));
      const cm = openModal(`
        <h3>盘点核对 — ${h(it.asset_name)}</h3>
        <div class="photo-row" style="margin-bottom:10px">${it.asset_photos.map((p) => `<img class="zoomable" src="${h(p)}">`).join('')}</div>
        <div class="form-row"><label>盘点结果 *</label><select id="ck-result"><option>一致</option><option>盘亏</option><option>信息不符</option></select></div>
        <div class="form-row"><label>实拍照片（点 ➕ 上传，支持拍照/粘贴）</label><div class="photo-row" id="ck-photos"></div></div>
        <div class="modal-actions"><button class="btn" id="ck-cancel">返回</button><button class="btn primary" id="ck-save">提交核对</button></div>`);
      const up = photoUploader(cm.querySelector('#ck-photos'), []);
      cm.querySelector('#ck-cancel').onclick = () => { closeModal(); inventoryDetail(id); };
      cm.querySelector('#ck-save').onclick = async () => {
        try {
          await api.post(`/api/inventory/items/${itemId}/check`, { result: cm.querySelector('#ck-result').value, photos: up.getUrls() });
          toast('已核对'); closeModal(); inventoryDetail(id);
        } catch (e) { toast(e.message, true); }
      };
    }
    if (m.querySelector('#iv-finish')) m.querySelector('#iv-finish').onclick = async () => {
      try {
        const r = await api.post(`/api/inventory/${id}/finish`, {});
        toast(r.diff > 0 ? `盘点完成，发现 ${r.diff} 项差异，请行政复核处理` : '盘点完成，无差异 🎉');
        closeModal(); renderInventory();
      } catch (e) { toast(e.message, true); }
    };
    renderItems();
  }

  // ---------- 基础数据管理（超管/行政） ----------
  async function renderAdmin(tab) {
    tab = tab || 'campuses';
    const u = api.getUser();
    if (!hasR(u, 'admin')) return void (location.hash = '#/dashboard');
    layout(topbar('基础数据管理') + `
      <div class="toolbar">
        ${[['campuses', '校区'], ['categories', '资产分类'], ['locations', '存放地点']].map(([k, label]) =>
          `<button class="btn ${tab === k ? 'primary' : ''}" data-tab="${k}">${label}</button>`).join('')}
      </div>
      <div class="card"><div class="table-wrap" id="admin-body"><div class="empty">加载中...</div></div></div>`, '#/admin');
    document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => renderAdmin(b.dataset.tab));
    const body = document.getElementById('admin-body');

    if (tab === 'campuses') {
      const rows = await api.get('/api/dicts/campuses');
      body.innerHTML = `<div class="toolbar"><button class="btn primary" id="add-row">+ 新增校区</button></div>
        <table><thead><tr><th>名称</th><th>简码</th><th>负责人</th><th>状态</th><th></th></tr></thead>
        <tbody>${rows.map((c) => `<tr><td>${h(c.name)}</td><td>${h(c.code)}</td><td>${h(c.head_name || '—')}</td><td>${badge(c.status, c.status === '启用' ? 'green' : 'gray')}</td>
        <td><button class="btn sm" data-edit='${h(JSON.stringify(c))}'>编辑</button></td></tr>`).join('')}</tbody></table>`;
      document.getElementById('add-row').onclick = () => campusForm(null);
      body.querySelectorAll('[data-edit]').forEach((el) => el.onclick = () => campusForm(JSON.parse(el.dataset.edit)));
    } else if (tab === 'categories') {
      const rows = await api.get('/api/dicts/categories');
      body.innerHTML = `<div class="toolbar"><button class="btn primary" id="add-row">+ 新增分类</button>
        <span style="font-size:12px;color:var(--text-2)">折旧口径：年限平均法按月计提，净残值率默认 5%，当月入账次月起算</span></div>
        <table><thead><tr><th>名称</th><th>编码</th><th>折旧年限</th><th>净残值率</th><th>状态</th><th></th></tr></thead>
        <tbody>${rows.map((c) => `<tr><td>${h(c.name)}</td><td>${h(c.code)}</td><td>${c.life_years} 年</td><td>${Math.round((c.salvage_rate != null ? c.salvage_rate : 0.05) * 100)}%</td><td>${badge(c.status, c.status === '启用' ? 'green' : 'gray')}</td>
        <td><button class="btn sm" data-edit='${h(JSON.stringify(c))}'>编辑</button></td></tr>`).join('')}</tbody></table>`;
      document.getElementById('add-row').onclick = () => categoryForm(null);
      body.querySelectorAll('[data-edit]').forEach((el) => el.onclick = () => categoryForm(JSON.parse(el.dataset.edit)));
    } else if (tab === 'locations') {
      const rows = await api.get('/api/dicts/locations');
      body.innerHTML = `<div class="toolbar"><button class="btn primary" id="add-row">+ 新增地点</button></div>
        <table><thead><tr><th>名称</th><th>所属校区</th><th>部门</th><th>状态</th><th></th></tr></thead>
        <tbody>${rows.map((l) => `<tr><td>${h(l.name)}</td><td>${h(l.campus_name)}</td><td>${h(l.department || '—')}</td><td>${badge(l.status, l.status === '启用' ? 'green' : 'gray')}</td>
        <td><button class="btn sm" data-edit='${h(JSON.stringify(l))}'>编辑</button></td></tr>`).join('')}</tbody></table>`;
      document.getElementById('add-row').onclick = () => locationForm(null);
      body.querySelectorAll('[data-edit]').forEach((el) => el.onclick = () => locationForm(JSON.parse(el.dataset.edit)));
    }
  }

  // ---------- 用户与权限（超级管理员专属） ----------
  async function renderUsers() {
    const u = api.getUser();
    if (u.role !== 'superadmin') return void (location.hash = '#/dashboard');
    layout(topbar('用户与权限', '<button class="btn primary" id="add-user-btn">+ 开通账号</button>') + `
      <div class="card">
        <div style="font-size:12.5px;color:var(--text-2);margin-bottom:12px;line-height:1.7">
          角色权限说明：<b>超级管理员</b> 全部权限+账号管理 · <b>行政后勤</b> 全部校区资产/单据管理与执行 · <b>校区负责人</b> 仅本校区（审批+盘点+期初建档） · <b>教师</b> 仅本人资产（申请领用借用/报修，不可见金额） · <b>财务</b> 全校区只读+报废审核 · <b>校长</b> 全校区只读+看板
        </div>
        <div class="table-wrap" id="users-body"><div class="empty">加载中...</div></div>
      </div>`, '#/users');
    document.getElementById('add-user-btn').onclick = () => userForm(null);
    let rows;
    try { rows = await api.get('/api/dicts/users'); } catch (e) { return toast(e.message, true); }
    const body = document.getElementById('users-body');
    const ROLE_BADGE = { superadmin: 'red', admin: 'blue', head: 'orange', teacher: 'green', finance: 'gray', principal: 'blue' };
    body.innerHTML = `<table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>所属校区</th><th>状态</th><th>创建时间</th><th></th></tr></thead>
      <tbody>${rows.map((x) => `<tr>
        <td>${h(x.username)}</td><td>${h(x.name)}</td><td>${badge(ROLE_NAMES[x.role] || x.role, ROLE_BADGE[x.role])}</td>
        <td>${h(x.campus_name || '—')}</td>
        <td>${x.is_active ? badge('启用', 'green') : badge('停用', 'gray')}</td>
        <td>${fmtDate(x.created_at)}</td>
        <td><button class="btn sm" data-edit='${h(JSON.stringify(x))}'>编辑</button></td></tr>`).join('')}</tbody></table>`;
    body.querySelectorAll('[data-edit]').forEach((el) => el.onclick = () => userForm(JSON.parse(el.dataset.edit)));
  }

  function userForm(x) {
    api.get('/api/dicts/campuses').then((campuses) => {
      const m = openModal(`
        <h3>${x ? '编辑账号' : '开通账号'}</h3>
        <div class="form-grid">
          <div class="form-row"><label>登录账号（建议用手机号）*</label><input id="uf2-username" value="${h(x?.username || '')}" ${x ? 'disabled' : ''} placeholder="如：18507599754"></div>
          <div class="form-row"><label>姓名 *</label><input id="uf2-name" value="${h(x?.name || '')}"></div>
          <div class="form-row"><label>角色 *</label><select id="uf2-role">${['admin', 'head', 'teacher', 'finance', 'principal'].map((k) => `<option value="${k}" ${x?.role === k ? 'selected' : ''}>${ROLE_NAMES[k]}</option>`).join('')}</select></div>
          <div class="form-row"><label>所属校区</label><select id="uf2-campus"><option value="">—</option>${campuses.map((c) => `<option value="${c.id}" ${x?.campus_id === c.id ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label>${x ? '重置密码（留空不改）' : '初始密码 *（至少6位）'}</label><input id="uf2-password" type="password" placeholder="${x ? '' : '可告知本人后自行修改'}"></div>
          ${x ? `<div class="form-row"><label>状态</label><select id="uf2-active"><option value="1" ${x.is_active ? 'selected' : ''}>启用</option><option value="0" ${!x.is_active ? 'selected' : ''}>停用</option></select></div>` : ''}
        </div>
        <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="uf2-save">保存</button></div>`);
      m.querySelector('#uf2-save').onclick = async () => {
        const body = {
          name: m.querySelector('#uf2-name').value.trim(), role: m.querySelector('#uf2-role').value,
          campus_id: m.querySelector('#uf2-campus').value ? Number(m.querySelector('#uf2-campus').value) : null,
          password: m.querySelector('#uf2-password').value || undefined,
        };
        try {
          if (x) { body.is_active = Number(m.querySelector('#uf2-active').value); await api.put('/api/dicts/users/' + x.id, body); }
          else {
            body.username = m.querySelector('#uf2-username').value.trim();
            if (!body.username || !body.password) return toast('请填写账号和初始密码', true);
            await api.post('/api/dicts/users', body);
          }
          toast('已保存'); closeModal(); renderUsers();
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  // ---------- 修改本人密码 ----------
  function changePasswordForm() {
    const m = openModal(`
      <h3>🔑 修改密码</h3>
      <div class="form-row"><label>原密码 *</label><input id="cp-old" type="password" autocomplete="current-password"></div>
      <div class="form-row"><label>新密码 *（至少6位）</label><input id="cp-new" type="password" autocomplete="new-password"></div>
      <div class="form-row"><label>确认新密码 *</label><input id="cp-new2" type="password" autocomplete="new-password"></div>
      <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="cp-save">确认修改</button></div>`);
    m.querySelector('#cp-save').onclick = async () => {
      const oldPassword = m.querySelector('#cp-old').value;
      const newPassword = m.querySelector('#cp-new').value;
      const confirm2 = m.querySelector('#cp-new2').value;
      if (!oldPassword || !newPassword) return toast('请填写完整', true);
      if (newPassword !== confirm2) return toast('两次输入的新密码不一致', true);
      if (newPassword.length < 6) return toast('新密码至少 6 位', true);
      try {
        await api.post('/api/auth/change-password', { oldPassword, newPassword });
        toast('密码已修改，请重新登录');
        closeModal();
        setTimeout(() => api.logout(), 1200);
      } catch (e) { toast(e.message, true); }
    };
  }

  function campusForm(c) {
    const m = openModal(`
      <h3>${c ? '编辑校区' : '新增校区'}</h3>
      <div class="form-row"><label>校区名称 *</label><input id="cf2-name" value="${h(c?.name || '')}"></div>
      <div class="form-row"><label>校区简码（2 位字母）*</label><input id="cf2-code" value="${h(c?.code || '')}" ${c ? 'disabled' : ''} maxlength="4"></div>
      ${c ? `<div class="form-row"><label>状态</label><select id="cf2-status">${['启用', '停用'].map((s) => `<option ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>` : ''}
      <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="cf2-save">保存</button></div>`);
    m.querySelector('#cf2-save').onclick = async () => {
      try {
        if (c) await api.put('/api/dicts/campuses/' + c.id, { name: m.querySelector('#cf2-name').value.trim(), status: m.querySelector('#cf2-status')?.value });
        else await api.post('/api/dicts/campuses', { name: m.querySelector('#cf2-name').value.trim(), code: m.querySelector('#cf2-code').value.trim() });
        toast('已保存'); closeModal(); renderAdmin('campuses');
      } catch (e) { toast(e.message, true); }
    };
  }
  function categoryForm(c) {
    const m = openModal(`
      <h3>${c ? '编辑分类' : '新增分类'}</h3>
      <div class="form-row"><label>分类名称 *</label><input id="kf-name" value="${h(c?.name || '')}"></div>
      <div class="form-row"><label>分类编码（2 位数字）*</label><input id="kf-code" value="${h(c?.code || '')}" ${c ? 'disabled' : ''} maxlength="2"></div>
      <div class="form-row"><label>默认折旧年限</label><input id="kf-life" type="number" min="1" value="${c?.life_years || 5}"></div>
      <div class="form-row"><label>净残值率（%，默认 5）</label><input id="kf-salvage" type="number" min="0" max="50" step="0.1" value="${c?.salvage_rate != null ? Math.round(c.salvage_rate * 1000) / 10 : 5}"></div>
      ${c ? `<div class="form-row"><label>状态</label><select id="kf-status">${['启用', '停用'].map((s) => `<option ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>` : ''}
      <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="kf-save">保存</button></div>`);
    m.querySelector('#kf-save').onclick = async () => {
      const salvageRate = Math.min(50, Math.max(0, Number(m.querySelector('#kf-salvage').value || 5))) / 100;
      try {
        if (c) await api.put('/api/dicts/categories/' + c.id, { name: m.querySelector('#kf-name').value.trim(), life_years: Number(m.querySelector('#kf-life').value), salvage_rate: salvageRate, status: m.querySelector('#kf-status')?.value });
        else await api.post('/api/dicts/categories', { name: m.querySelector('#kf-name').value.trim(), code: m.querySelector('#kf-code').value.trim(), life_years: Number(m.querySelector('#kf-life').value), salvage_rate: salvageRate });
        toast('已保存'); closeModal(); renderAdmin('categories');
      } catch (e) { toast(e.message, true); }
    };
  }
  function locationForm(l) {
    api.get('/api/dicts/campuses').then((campuses) => {
      const m = openModal(`
        <h3>${l ? '编辑地点' : '新增地点'}</h3>
        <div class="form-row"><label>地点名称 *</label><input id="lf-name" value="${h(l?.name || '')}"></div>
        ${l ? '' : `<div class="form-row"><label>所属校区 *</label><select id="lf-campus">${campuses.map((c) => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select></div>`}
        <div class="form-row"><label>部门</label><input id="lf-dept" value="${h(l?.department || '')}"></div>
        ${l ? `<div class="form-row"><label>状态</label><select id="lf-status">${['启用', '停用'].map((s) => `<option ${l.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>` : ''}
        <div class="modal-actions"><button class="btn" onclick="document.getElementById('modal-mask').remove()">取消</button><button class="btn primary" id="lf-save">保存</button></div>`);
      m.querySelector('#lf-save').onclick = async () => {
        try {
          if (l) await api.put('/api/dicts/locations/' + l.id, { name: m.querySelector('#lf-name').value.trim(), department: m.querySelector('#lf-dept').value.trim(), status: m.querySelector('#lf-status')?.value });
          else await api.post('/api/dicts/locations', { name: m.querySelector('#lf-name').value.trim(), campus_id: Number(m.querySelector('#lf-campus').value), department: m.querySelector('#lf-dept').value.trim() });
          toast('已保存'); closeModal(); renderAdmin('locations');
        } catch (e) { toast(e.message, true); }
      };
    });
  }

  // ---------- 更多（移动端） ----------
  function renderMore() {
    const u = api.getUser();
    const items = NAV.flatMap((g) => g.items).filter((n) => (!n.roles || n.roles.includes(u.role)) && n.id !== 'more');
    layout(topbar('更多功能') + `<div class="card more-list">
      ${items.map((n) => `<a class="more-item" href="${n.href}" data-more="${n.id}"><span class="mi">${ZXShell.icon(n.icon)}</span>${n.label}</a>`).join('')}
      <a class="more-item danger" href="javascript:void(0)" id="more-logout"><span class="mi">${ZXShell.icon('logout')}</span>退出登录</a>
    </div>`, '#/more');
    document.querySelector('[data-more="pwd"]').onclick = () => { changePasswordForm(); return false; };
    document.getElementById('more-logout').onclick = () => api.logout();
  }

  // ---------- 路由 ----------
  function parseHash() {
    const hash = location.hash.slice(1) || '/dashboard';
    const [path, qs] = hash.split('?');
    const query = {};
    if (qs) new URLSearchParams(qs).forEach((v, k) => (query[k] = v));
    return { path, query };
  }

  async function route() {
    closeModal();
    // 若 sessionStorage 无用户，先探测 Cookie 会话（可能仍有效）
    if (!api.isLoggedIn()) {
      const u0 = await api.probeSession();
      if (!u0) return renderLogin();
    }
    const { path, query } = parseHash();
    const u = api.getUser();
    if (u.role === 'teacher' && (path === '/dashboard' || path === '/')) return void (location.hash = '#/assets');
    switch (path) {
      case '/dashboard': renderDashboard(); break;
      case '/todo': renderTodo(); break;
      case '/assets': renderAssets(query); break;
      case '/purchases': renderPurchases(query); break;
      case '/usages': renderUsages(query); break;
      case '/changes': renderChanges(query); break;
      case '/inventory': renderInventory(); break;
      case '/admin': renderAdmin(); break;
      case '/users': renderUsers(); break;
      case '/more': renderMore(); break;
      case '/login': renderLogin(); break;
      default: location.hash = '#/dashboard';
    }
  }

  window.addEventListener('hashchange', route);
  route();
})();
