// API 客户端：同源 fetch 封装
// 会话凭证以 HttpOnly Cookie 为主（浏览器自动携带，可穿透反向代理，且 JS 无法读取、更安全），
// 同时附带 Authorization / X-Auth-Token 头兜底；401 自动刷新重试一次，失败则回登录页。
(function () {
  let accessToken = sessionStorage.getItem('am_at') || null;
  let refreshToken = sessionStorage.getItem('am_rt') || null;
  let currentUser = null;
  try { currentUser = JSON.parse(sessionStorage.getItem('am_user') || 'null'); } catch (e) {}

  function saveTokens(at, rt, user) {
    accessToken = at; refreshToken = rt; currentUser = user || currentUser;
    if (at) sessionStorage.setItem('am_at', at);
    if (rt) sessionStorage.setItem('am_rt', rt);
    if (currentUser) sessionStorage.setItem('am_user', JSON.stringify(currentUser));
  }
  function clearTokens() {
    accessToken = refreshToken = currentUser = null;
    sessionStorage.removeItem('am_at'); sessionStorage.removeItem('am_rt'); sessionStorage.removeItem('am_user');
  }

  async function doRefresh() {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: refreshToken ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshToken || '' }),
      credentials: 'same-origin', // 携带会话 Cookie
    });
    if (!res.ok) { clearTokens(); throw new Error('SESSION_EXPIRED'); }
    const data = await res.json();
    saveTokens(data.accessToken, data.refreshToken, data.user);
    return data.accessToken;
  }

  async function request(method, url, body, isRetry) {
    const headers = {};
    if (accessToken) {
      headers['Authorization'] = 'Bearer ' + accessToken;
      headers['X-Auth-Token'] = accessToken;
    }
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, {
        method, headers,
        credentials: 'same-origin', // 会话 Cookie 自动携带
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('网络连接失败，请检查网络后重试');
    }
    if (res.status === 401 && !isRetry) {
      // 先尝试刷新（有 refreshToken 时走刷新，否则可能是 Cookie 仍在而 sessionStorage 丢失，直接重试一次）
      try {
        if (refreshToken) await doRefresh();
        else throw new Error('NO_SESSION');
      } catch (e) {
        clearTokens();
        location.hash = '#/login';
        throw new Error('登录已过期，请重新登录');
      }
      return request(method, url, body, true);
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const msg = data && data.error && data.error.message ? data.error.message : `请求失败（${res.status}）`;
      throw new Error(msg);
    }
    return data;
  }

  // 启动时探测会话：Cookie 有效则恢复登录态（sessionStorage 丢失也不影响）
  async function probeSession() {
    if (currentUser) return currentUser;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      currentUser = data.user;
      sessionStorage.setItem('am_user', JSON.stringify(currentUser));
      return currentUser;
    } catch (e) { return null; }
  }

  window.api = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    upload: (files) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      return request('POST', '/api/assets/upload', fd);
    },
    saveTokens, clearTokens, probeSession,
    getUser: () => currentUser,
    isLoggedIn: () => !!currentUser,
    logout: async () => {
      try { await request('POST', '/api/auth/logout', { refreshToken: refreshToken || '' }); } catch (e) {}
      clearTokens();
      location.hash = '#/login';
    },
  };
})();
