// ======== v5.2.0 基础模块（I18N、State、Utils、API）========
//
// 本文件由原 app.js 拆分而来，集中存放跨模块共享的状态、字典、工具函数。
// 加载顺序：必须最先加载。

(function (global) {
  'use strict';

  // ======== i18n（统一状态/优先级/来源/类型的中文映射）========
  const I18N = {
    status: {
      pending: '⏳ 待处理',
      assigned: '⚙️ 处理中',  // v5.1.1: 合并 assigned → 处理中（与 processing 同义）
      processing: '⚙️ 处理中',
      completed: '✅ 已完成',
      failed: '❌ 失败'
    },
    priority: {
      low: '低',
      normal: '普通',
      high: '高',
      urgent: '紧急'
    },
    source: {
      wechat: '💬 微信',
      chat: '💬 聊天',
      manual: '✍️ 手动',
      scheduled: '⏰ 定时',
      system: '⚙️ 系统',
      workflow: '🔄 工作流'
    },
    type: {
      chat: '聊天',
      reply_message: '回复消息',
      query_info: '信息查询',
      analyze_data: '数据分析',
      generate_content: '内容生成',
      execute_command: '执行命令',
      multi_step: '多步任务'
    }
  };

  function i18n(map, key) {
    return (I18N[map] && I18N[map][key]) || key;
  }

  // ======== State（全局共享状态）========
  const state = {
    sessions: [],
    currentSessionId: null,
    tasks: [],
    currentTaskId: null,
    currentFilter: 'all',
    sessionFilter: 'active',
    sessionSearch: '',
    detailTab: 'overview',
    currentTab: 'chat',          // v4.2.1: 当前 tab
    stats: null,
    claw: {
      status: null,           // { state, wxid, nickname, ... }
      modalOpen: false,
      qrcodeTimer: null,
      lastQrcodeExpiresAt: null,
      pollingTimer: null,     // v5.2.1: 状态轮询定时器
      lastPolledState: null   // v5.2.1: 上次轮询的状态（用于 diff 触发重渲染）
    },
    workflows: [],               // v4.2.1: 工作流列表
    currentWorkflowId: null,     // v4.2.1: 当前工作流
    kbCategories: [],            // v4.2.1: 知识库分类
    currentKbCategoryId: null,   // v4.2.1: 当前分类
    kbItems: [],                 // v4.2.1: 知识库条目
    kbLinks: [],                 // v4.3.0: 知识图谱关联
    kbView: 'list',              // v4.3.0: KB 视图（list | graph）
    cy: null,                    // v4.3.0: Cytoscape 实例
    plans: [],                   // v5.1.0: 计划条目列表
    currentPlanId: null,         // v5.1.0: 当前选中计划
    planFilter: {
      search: '',
      type: 'all',               // all | day | week
      status: 'all',             // all | pending | in_progress | done | cancelled
      week: 'current'            // current | next | all
    }
  };

  // 跨模块共享的计时器
  let ws = null;
  let reconnectTimer = null;
  let heartbeatInterval = null;
  let planReminderTimer = null;

  // ======== Utils ========
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toTimeString().slice(0, 8);
    }
    return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`;
  }

  function formatRelative(ts) {
    if (!ts) return '-';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
    return new Date(ts).toLocaleDateString();
  }

  function formatBytes(bytes) {
    if (bytes == null) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  /**
   * 把 HTTP 状态码 + 后端错误消息转换为用户可读的中文提示
   * 优先使用后端返回的中文错误（后端是真相之源），否则按状态码映射
   */
  function humanizeHttpError(status, payload) {
    if (payload && typeof payload.error === 'string' && /[\u4e00-\u9fa5]/.test(payload.error)) {
      return payload.error;
    }
    if (status === 0 || status == null) return '网络连接失败，请检查服务是否启动';
    if (status === 400) return '请求参数有误';
    if (status === 401) return '未授权，请重新登录';
    if (status === 403) return '无权限访问此资源';
    if (status === 404) return '资源不存在或已删除';
    if (status === 408) return '请求超时，请稍后重试';
    if (status === 409) return '操作冲突，请刷新后重试';
    if (status === 413) return '请求内容过大';
    if (status === 422) return '数据校验失败';
    if (status === 429) return '请求过于频繁，请稍后再试';
    if (status >= 500 && status < 600) return '服务器异常，请稍后重试';
    return `请求失败 (${status})`;
  }

  /**
   * 通知弹窗（v5.2.0 增强）
   * - options 形式：{ msg, type, duration, technical, copyable }
   *   - technical: 技术详情（堆栈/技术消息），开启 copyable 时显示
   *   - copyable: 是否显示"复制详情"按钮（error 时默认 true）
   * - 兼容旧签名：showNotification(msg, type, duration)
   */
  function showNotification(arg1, arg2, arg3) {
    let opts;
    if (typeof arg1 === 'object' && arg1 !== null) {
      opts = arg1;
    } else {
      opts = { msg: arg1, type: arg2, duration: arg3 };
    }
    const msg = opts.msg || '';
    const type = opts.type || 'info';
    const duration = opts.duration || (type === 'error' ? 6000 : 3000);
    // 自动注入：如果是 error 且未显式提供 technical，则从最近一次 API 错误中取
    // 这样现有所有 `showNotification(`❌ ${e.message}`, 'error')` 调用都能自动获得复制按钮
    let technical = opts.technical || null;
    if (type === 'error' && !technical && global.__lastApiError) {
      technical = [
        global.__lastApiError.path && `URL: ${global.__lastApiError.path}`,
        global.__lastApiError.status && `HTTP: ${global.__lastApiError.status}`,
        global.__lastApiError.technical
      ].filter(Boolean).join('\n');
    }
    const copyable = opts.copyable != null ? opts.copyable : (type === 'error' && !!technical);

    const container = document.getElementById('notification-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `notification ${type}`;
    el.style.position = 'relative';
    el.style.paddingRight = copyable ? '38px' : '14px';

    // 内容容器
    const content = document.createElement('div');
    content.className = 'notification-content';
    content.textContent = msg;
    el.appendChild(content);

    // 复制按钮（仅 error + 有 technical 时）
    if (copyable) {
      const btn = document.createElement('button');
      btn.className = 'notification-copy';
      btn.title = '复制错误详情';
      btn.textContent = '📋';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const detail = `[${type.toUpperCase()}] ${msg}\n${technical}`;
        copyToClipboard(detail).then(
          () => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '📋'; }, 1500); },
          () => { btn.textContent = '✗'; setTimeout(() => { btn.textContent = '📋'; }, 1500); }
        );
      });
      el.appendChild(btn);
    }

    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  /**
   * 复制文本到剪贴板（带降级）
   */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {}
    // 降级：textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  }

  /**
   * 统一 API 调用（v5.2.0 增强错误处理）
   * - 错误 message 自动转中文（humanizeHttpError）
   * - 保留 e.technical/e.status/e.payload/e.network 用于调试与"复制详情"
   * - 网络层失败标记 e.network=true，全局处理器据此弹"已离线"
   */
  async function api(path, options = {}) {
    const opts = { headers: { 'Content-Type': 'application/json' }, ...options };
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);

    let resp;
    try {
      resp = await fetch(path, opts);
    } catch (err) {
      const technical = String(err.message || err);
      const e = new Error('网络连接失败，请检查服务是否启动');
      e.cause = err;
      e.path = path;
      e.network = true;
      e.technical = technical;
      console.error('[api] network error', path, technical);
      global.__lastApiError = e;
      throw e;
    }

    // 尝试解析 JSON；解析失败时使用状态码兜底
    let data = null;
    let parseErr = null;
    try {
      data = await resp.json();
    } catch (e) {
      parseErr = e;
    }

    if (!resp.ok || (data && data.success === false)) {
      const technical = (data && data.error)
        || (parseErr ? `响应解析失败 (${resp.status})` : `HTTP ${resp.status}`);
      const userMsg = humanizeHttpError(resp.status, data);
      const e = new Error(userMsg);
      e.status = resp.status;
      e.path = path;
      e.payload = data;
      e.technical = technical;
      e.parseError = parseErr ? parseErr.message : null;
      console.error('[api] http error', path, resp.status, technical);
      global.__lastApiError = e;
      throw e;
    }

    if (parseErr) {
      // 200 但 JSON 损坏（极少见）：返回包装对象避免下游崩溃
      console.warn('[api] json parse warning', path, parseErr.message);
      return { success: true, data: null, _parseWarning: parseErr.message };
    }

    return data;
  }

  /**
   * 通知限流：同 key 在 windowMs 毫秒内只显示一次
   * 用于防止 unhandledrejection / 资源错误刷屏
   */
  const _notifyDedup = new Map();
  function shouldNotify(key, windowMs = 60000) {
    const now = Date.now();
    const last = _notifyDedup.get(key) || 0;
    if (now - last < windowMs) return false;
    _notifyDedup.set(key, now);
    return true;
  }

  /**
   * 全局错误处理（v5.2.0 增强）
   * - 同步异常 → 弹"操作异常"通知（限流 60s）
   * - unhandled rejection → 弹通知（限流 60s）
   * - 资源加载失败 → 静默 console（已记录），除非是用户关键资源
   * - 离线检测：网络错首次出现时弹"已离线"
   */
  function installGlobalErrorHandlers() {
    window.addEventListener('error', (ev) => {
      // 资源加载失败（404 等）单独处理
      if (ev.target && (ev.target.tagName === 'SCRIPT' || ev.target.tagName === 'LINK' || ev.target.tagName === 'IMG')) {
        const url = ev.target.src || ev.target.href || '';
        console.warn('[resource-error]', ev.target.tagName, url);
        return;
      }
      // 同步 JS 异常
      const msg = ev.message || (ev.error && ev.error.message) || '未知错误';
      const stack = ev.error && ev.error.stack ? ev.error.stack : '';
      console.error('[window.error]', msg, ev.error || ev);
      if (shouldNotify(`js:${msg}`)) {
        showNotification({
          msg: `操作异常: ${msg.length > 30 ? msg.slice(0, 30) + '…' : msg}`,
          type: 'error',
          technical: stack || msg
        });
      }
    });

    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev.reason || {};
      const msg = (reason && reason.message) || String(reason) || '未知 Promise 异常';
      const stack = reason && reason.stack ? reason.stack : '';
      console.error('[unhandledrejection]', msg, reason);
      if (shouldNotify(`rej:${msg}`)) {
        showNotification({
          msg: `操作未完成: ${msg.length > 30 ? msg.slice(0, 30) + '…' : msg}`,
          type: 'error',
          technical: stack || msg
        });
      }
      ev.preventDefault();
    });

    // 资源加载错误（capture 阶段才能监听到）
    window.addEventListener('error', (ev) => {
      if (ev.target && (ev.target.tagName === 'SCRIPT' || ev.target.tagName === 'LINK' || ev.target.tagName === 'IMG')) {
        const url = ev.target.src || ev.target.href || '';
        console.warn('[resource-error]', ev.target.tagName, url);
        // 关键资源（CDN）失败时通知一次
        if (url.includes('cytoscape') && shouldNotify('cdn:cytoscape')) {
          showNotification({
            msg: '知识图谱组件加载失败，图谱视图不可用',
            type: 'warning',
            duration: 5000
          });
        }
      }
    }, true);
  }

  // ======== Hash Routing (v5.2.1 移到 core.js，避免 sessions/tasks 在 main.js 之前加载时拿不到 setHash) ========
  function setHash(hash) {
    if (window.location.hash === hash) return;
    history.pushState('', document.title, window.location.pathname + window.location.search + hash);
  }

  // 暴露到 window
  global.Core = {
    I18N,
    i18n,
    state,
    escapeHtml,
    formatTime,
    formatRelative,
    formatBytes,
    showNotification,
    api,
    copyToClipboard,
    humanizeHttpError,
    shouldNotify,
    installGlobalErrorHandlers,
    setHash,
    // 共享计时器（其他模块需要时通过 Core.ws/Core.heartbeatInterval 访问）
    get ws() { return ws; },
    set ws(v) { ws = v; },
    get reconnectTimer() { return reconnectTimer; },
    set reconnectTimer(v) { reconnectTimer = v; },
    get heartbeatInterval() { return heartbeatInterval; },
    set heartbeatInterval(v) { heartbeatInterval = v; },
    get planReminderTimer() { return planReminderTimer; },
    set planReminderTimer(v) { planReminderTimer = v; }
  };
})(window);
