/* ============================================================
   main.js — 启动入口：鉴权检查 → 渲染布局 → hash 路由分发
   ============================================================ */
import { api, getToken, clearToken, currentUser, toast, closeDrawer } from './api.js';
import { renderSidebar, currentRoute, navigate, routeLabel, toggleMobileSidebar } from './nav.js';

const app = document.getElementById('app');

/** 未登录 → 跳登录页 */
if (!getToken()) {
  location.href = '/login.html';
}

/** 页面清理回调（轮询定时器等） */
let cleanups = [];
function runCleanups() {
  cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  cleanups = [];
  closeDrawer();
}

/** 传给页面模块的上下文 */
function makeCtx(route) {
  return {
    api,
    toast,
    user: currentUser(),
    navigate,
    route,
    /** 页面注册清理函数，路由切换时执行 */
    onCleanup(fn) { cleanups.push(fn); },
    /** 重新渲染当前页 */
    refresh: () => dispatch(),
  };
}

/** 渲染整体布局（侧边栏 + 顶栏 + 内容容器） */
function renderLayout() {
  app.className = '';
  app.innerHTML = `
    <div class="layout">
      <aside id="sidebar"></aside>
      <div class="sidebar-mask" id="sidebarMask"></div>
      <div class="main">
        <header class="topbar">
          <button class="topbar-hamburger" id="hamburger" title="菜单" aria-label="菜单">☰</button>
          <div class="page-title" id="pageTitle"></div>
          <div class="topbar-right">
            <span id="topUser"></span>
            <button class="btn btn-sm btn-ghost" id="logoutBtn">退出登录</button>
          </div>
        </header>
        <main class="content"><div class="content-inner" id="pageRoot"></div></main>
      </div>
    </div>`;
  const user = currentUser();
  document.getElementById('topUser').textContent = `👤 ${user.username || '用户'}${(user.roles || []).includes('admin') ? '（管理员）' : ''}`;
  document.getElementById('logoutBtn').addEventListener('click', () => {
    clearToken();
    location.href = '/login.html';
  });
  // 汉堡按钮：移动端唤出侧边栏抽屉
  document.getElementById('hamburger').addEventListener('click', toggleMobileSidebar);
  // 遮罩点击关闭
  document.getElementById('sidebarMask').addEventListener('click', () => {
    document.body.classList.remove('sidebar-open');
  });
  // 路由切换时自动关闭移动端抽屉
  window.addEventListener('hashchange', () => {
    if (window.matchMedia('(max-width: 768px)').matches) {
      document.body.classList.remove('sidebar-open');
    }
    // 离开 chat 页面时清掉 chat-show-* 视图类
    if (!location.hash.startsWith('#/chat')) {
      document.body.classList.remove('chat-show-sessions', 'chat-show-detail');
    }
  }, { passive: true });
}

/** 路由分发：动态加载 pages/<route>.js 并调用 render(el, ctx) */
async function dispatch() {
  const route = currentRoute();
  runCleanups();
  renderSidebar(document.getElementById('sidebar'), route);
  document.getElementById('pageTitle').textContent = routeLabel(route);
  const root = document.getElementById('pageRoot');
  root.innerHTML = '<div class="loading-line"><span class="spinner"></span> 页面加载中…</div>';
  let mod;
  try {
    mod = await import(`./pages/${route}.js`);
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="empty"><div class="empty-icon">🧩</div><p>页面模块加载失败：${route}</p><p class="empty-tip">${err.message || ''}</p></div>`;
    return;
  }
  // 若加载期间路由已变化，丢弃本次渲染
  if (currentRoute() !== route) return;
  root.innerHTML = '';
  try {
    await mod.render(root, makeCtx(route));
  } catch (err) {
    console.error(err);
    toast(err.message || '页面渲染失败', 'error');
    root.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p>页面渲染出错</p><p class="empty-tip">${err.message || ''}</p></div>`;
  }
}

function boot() {
  if (!location.hash) navigate('overview');
  renderLayout();
  dispatch();
  window.addEventListener('hashchange', dispatch);
}

boot();

// 静默预取，验证 token 有效性（失效时 api.js 会自动跳登录）
api.get('/api/overview').catch(() => {});
