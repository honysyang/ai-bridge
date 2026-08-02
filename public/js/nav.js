/* ============================================================
   nav.js — 菜单配置数组 + 侧边栏渲染 + hash 路由骨架
   ============================================================ */

/** 菜单配置数组：侧边栏按此渲染 */
export const MENUS = [
  { path: 'overview', icon: '📊', label: '概览' },
  { path: 'tasks', icon: '📋', label: '任务中心' },
  { path: 'chat', icon: '💬', label: '对话' },
  { path: 'agents', icon: '🤖', label: '智能体' },
  { path: 'kb', icon: '📚', label: '知识库' },
  { path: 'workflows', icon: '🔀', label: '工作流' },
  { path: 'claw', icon: '📨', label: '消息通信' },
];

/** 侧边栏底部入口 */
export const BOTTOM_MENUS = [
  { path: 'settings', icon: '⚙️', label: '设置' },
];

const COLLAPSE_KEY = 'ab_sidebar_collapsed';

export function isCollapsed() { return localStorage.getItem(COLLAPSE_KEY) === '1'; }

/** 当前 hash 路由（不含 #/ 前缀） */
export function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  const all = [...MENUS, ...BOTTOM_MENUS];
  return all.some((m) => m.path === h) ? h : 'overview';
}

export function navigate(path) {
  location.hash = `#/${path}`;
}

function navItemHTML(m, route) {
  return `<div class="nav-item${m.path === route ? ' active' : ''}" data-path="${m.path}" title="${m.label}">
    <span class="nav-icon">${m.icon}</span><span class="nav-label">${m.label}</span>
  </div>`;
}

/** 渲染侧边栏到 el（el 为 <aside>），collapsed 状态持久化 */
export function renderSidebar(el, route) {
  const collapsed = isCollapsed();
  el.className = `sidebar${collapsed ? ' collapsed' : ''}`;
  el.innerHTML = `
    <div class="sidebar-brand">
      <img src="/imges/logo2.png" class="logo" alt="鹤仙人 ai-bridge">
      <div class="brand-text">鹤仙人<small>ai-bridge v7.0</small></div>
    </div>
    <nav class="sidebar-nav">${MENUS.map((m) => navItemHTML(m, route)).join('')}</nav>
    <div class="sidebar-bottom">
      ${BOTTOM_MENUS.map((m) => navItemHTML(m, route)).join('')}
      <button class="sidebar-toggle" title="${collapsed ? '展开侧边栏' : '折叠侧边栏'}">${collapsed ? '» 展开' : '« 折叠'}</button>
    </div>`;
  el.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      navigate(item.dataset.path);
      // 移动端：点击后自动收起抽屉
      if (window.matchMedia('(max-width: 768px)').matches) {
        document.body.classList.remove('sidebar-open');
      }
    });
  });
  el.querySelector('.sidebar-toggle').addEventListener('click', () => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '0' : '1');
    renderSidebar(el, route);
  });
}

/** 移动端：唤出 / 收起侧边栏抽屉（由顶栏汉堡按钮触发） */
export function toggleMobileSidebar() {
  document.body.classList.toggle('sidebar-open');
}

/** 菜单 label 查找（顶栏标题用） */
export function routeLabel(path) {
  const m = [...MENUS, ...BOTTOM_MENUS].find((x) => x.path === path);
  return m ? `${m.icon} ${m.label}` : path;
}
