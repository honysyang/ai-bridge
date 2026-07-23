// ======== v5.2.0 Main 入口模块 ========
//
// 应用启动、tab 切换、心跳、WebSocket、统计、抽屉/模态框、事件绑定。
// 加载顺序：必须最后加载（依赖其他所有模块）。

(function (global) {
  'use strict';

  const { state, i18n, api, escapeHtml, formatTime, formatBytes, showNotification } = global.Core;

  // ======== Tab 切换 ========
  const TAB_PANELS = {
    chat: 'panel-chat',
    kb: 'panel-kb',
    workflow: 'panel-workflow',
    plan: 'panel-plan'
  };

  const TAB_INIT = {
    chat: null,            // 始终初始化（init 流程已加载）
    kb: 'initKB',
    workflow: 'initWF',
    plan: 'initPlan'
  };

  function switchTab(tabName, opts = {}) {
    if (!TAB_PANELS[tabName]) {
      console.warn(`[switchTab] 未知 tab: ${tabName}，回退到 chat`);
      tabName = 'chat';
    }

    const previous = state.currentTab;
    state.currentTab = tabName;

    document.querySelectorAll('.tab-menu .tab-btn').forEach(btn => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    Object.entries(TAB_PANELS).forEach(([key, panelId]) => {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      if (key === tabName) {
        panel.style.display = '';
        panel.hidden = false;
        panel.style.animation = 'none';
        void panel.offsetWidth;
        panel.style.animation = '';
      } else {
        panel.style.display = 'none';
        panel.hidden = true;
      }
    });

    if (previous !== tabName && TAB_INIT[tabName]) {
      const initFn = window[TAB_INIT[tabName]];
      if (typeof initFn === 'function') initFn();
    }

    updateTabCounts();

    if (tabName === 'kb' && /graph$/.test(location.hash)) {
      setTimeout(() => {
        const btn = document.querySelector('#kb-view-tabs .tab[data-view="graph"]');
        if (btn) btn.click();
      }, 500);
    }
    if (tabName === 'plan' && /report$/.test(location.hash)) {
      setTimeout(() => {
        if (typeof window.openWeeklyReportDrawer === 'function') window.openWeeklyReportDrawer();
      }, 500);
    }
    if (tabName === 'chat' && /claw$/.test(location.hash)) {
      setTimeout(() => {
        const badge = document.getElementById('wechat-status');
        if (badge) badge.click();
      }, 500);
    }

    if (!opts.skipHash && location.hash !== `#tab/${tabName}`) {
      history.replaceState(null, '', `#tab/${tabName}`);
    }
  }

  function updateTabCounts() {
    const chatCount = document.getElementById('tab-count-chat');
    if (chatCount) {
      const n = (state.tasks || []).length;
      if (n > 0) { chatCount.textContent = n; chatCount.hidden = false; }
      else { chatCount.hidden = true; }
    }
    const kbCount = document.getElementById('tab-count-kb');
    if (kbCount) {
      const n = (state.kbItems || []).length;
      if (n > 0) { kbCount.textContent = n; kbCount.hidden = false; }
      else { kbCount.hidden = true; }
    }
    const wfCount = document.getElementById('tab-count-wf');
    if (wfCount) {
      const n = (state.workflows || []).length;
      if (n > 0) { wfCount.textContent = n; wfCount.hidden = false; }
      else { wfCount.hidden = true; }
    }
    const planCount = document.getElementById('tab-count-plan');
    if (planCount) {
      const n = (state.plans || []).length;
      if (n > 0) { planCount.textContent = n; planCount.hidden = false; }
      else { planCount.hidden = true; }
    }
  }

  // ======== Stats ========
  async function loadStats() {
    try {
      const { data } = await api('/api/storage/stats');
      state.stats = data;
    } catch (e) {
      console.error('loadStats:', e);
    }
  }

  function updateQueueStats(stats) {
    const el = document.getElementById('queue-stats');
    if (el) el.textContent = `队列: ${stats.pending || 0}待 / ${stats.processing || 0}处 / ${stats.completed || 0}完 / ${stats.failed || 0}败`;
  }

  async function loadStatsDrawer() {
    const body = document.getElementById('stats-drawer-body');
    if (!body) return;
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">加载中...</div></div>`;
    try {
      const { data } = await api('/api/storage/stats');
      body.innerHTML = `
        <div class="stats-card">
          <h4>📋 任务</h4>
          <div class="stats-row"><span>内存中</span><strong>${data.tasks.count}</strong></div>
          <div class="stats-row"><span>文件大小</span><strong>${formatBytes(data.tasks.file_size)}</strong></div>
          <div class="stats-row"><span>行数</span><strong>${data.tasks.file_lines}</strong></div>
          <div class="stats-row"><span>文件</span><strong style="font-size: 10px;">${escapeHtml(data.tasks.file)}</strong></div>
        </div>
        <div class="stats-card">
          <h4>📜 日志</h4>
          <div class="stats-row"><span>内存中</span><strong>${data.logs.count}</strong></div>
          <div class="stats-row"><span>总行数</span><strong>${data.logs.total_lines}</strong></div>
          <div class="stats-row"><span>文件大小</span><strong>${formatBytes(data.logs.file_size)}</strong></div>
        </div>
        <div class="stats-card">
          <h4>💬 会话</h4>
          <div class="stats-row"><span>内存中</span><strong>${data.sessions.count}</strong></div>
          <div class="stats-row"><span>文件大小</span><strong>${formatBytes(data.sessions.file_size)}</strong></div>
          <div class="stats-row"><span>行数</span><strong>${data.sessions.file_lines}</strong></div>
        </div>
        <div class="stats-card">
          <h4>💾 写入</h4>
          <div class="stats-row"><span>状态</span><strong>${data.writes.pending}</strong></div>
          <div class="stats-row"><span>累计</span><strong>${data.writes.count}</strong></div>
          <div class="stats-row"><span>错误</span><strong>${data.writes.errors}</strong></div>
        </div>
        <div class="stats-card">
          <h4>ℹ️ 系统</h4>
          <div class="stats-row"><span>版本</span><strong>v${data.version}</strong></div>
          <div class="stats-row"><span>数据目录</span><strong style="font-size: 10px;">${escapeHtml(data.data_dir)}</strong></div>
        </div>
      `;
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-text">${escapeHtml(e.message)}</div></div>`;
    }
  }

  async function exportData() {
    try {
      const { data } = await api('/api/storage/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-bridge-backup-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showNotification('📥 已导出', 'success');
    } catch (e) {
      showNotification(`❌ 导出失败: ${e.message}`, 'error');
    }
  }

  async function wipeData() {
    if (!confirm('⚠️ 危险操作！\n清空所有任务/日志/会话数据，且不可恢复。\n\n确认清空？')) return;
    if (!confirm('再次确认：真的要清空所有数据吗？')) return;
    try {
      await api('/api/storage/wipe', { method: 'POST' });
      showNotification('🗑 已清空', 'warning', 5000);
      state.currentSessionId = null;
      state.currentTaskId = null;
      if (global.Tasks && global.Tasks.enableCompose) global.Tasks.enableCompose(false);
      if (global.Sessions) await global.Sessions.loadSessions();
      if (global.Tasks) await global.Tasks.loadTasks();
    } catch (e) {
      showNotification(`❌ ${e.message}`, 'error');
    }
  }

  // ======== Logs Drawer ========
  async function loadLogsDrawer() {
    const level = document.getElementById('log-level-filter');
    const source = document.getElementById('log-source-filter');
    const params = new URLSearchParams();
    if (level) params.set('level', level.value);
    if (source) params.set('source', source.value);
    params.set('limit', '200');

    const body = document.getElementById('log-drawer-list');
    if (!body) return;
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">加载中...</div></div>`;

    try {
      const { data } = await api(`/api/logs?${params}`);
      if (!data.length) {
        body.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">暂无日志</div></div>`;
        return;
      }
      body.innerHTML = `<div class="log-list">${data.map(l => `
        <div class="log-item ${l.level}">
          <span class="log-time">${formatTime(l.created_at)}</span>
          <span class="log-text"><strong>${escapeHtml(l.source)}</strong>: ${escapeHtml(l.message)}</span>
        </div>
      `).join('')}</div>`;
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-text">${escapeHtml(e.message)}</div></div>`;
    }
  }

  // ======== WebSocket（v5.2.0 增强错误处理）========
  function connectWebSocket() {
    if (global.Core.ws && global.Core.ws.readyState === WebSocket.OPEN) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[ws] 创建失败:', err);
      global.Core.reconnectTimer = setTimeout(connectWebSocket, 5000);
      return;
    }
    global.Core.ws = socket;

    socket.onopen = () => {
      const status = document.getElementById('connection-status');
      if (status) {
        status.className = 'status connected';
        status.innerHTML = '● 已连接';
      }
      if (global.Core.reconnectTimer) {
        clearTimeout(global.Core.reconnectTimer);
        global.Core.reconnectTimer = null;
      }
    };
    socket.onerror = (ev) => {
      // 仅记录，不弹通知（onclose 会触发重连）
      console.warn('[ws] error', ev);
    };
    socket.onclose = () => {
      const status = document.getElementById('connection-status');
      if (status) {
        status.className = 'status disconnected';
        status.innerHTML = '● 已断开';
      }
      global.Core.reconnectTimer = setTimeout(connectWebSocket, 5000);
    };
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleWSMessage(msg);
      } catch (err) {
        console.warn('[ws] 消息解析失败:', err);
      }
    };
  }

  function handleWSMessage(msg) {
    if (msg.type === 'task_added' || msg.type === 'task_assigned' || msg.type === 'task_completed' || msg.type === 'task_deleted') {
      if (state.currentSessionId && (msg.data?.session_id === state.currentSessionId || msg.data?.task_id === state.currentTaskId)) {
        if (global.Tasks) global.Tasks.loadTasks();
      }
      if (global.Sessions) global.Sessions.loadSessions();
      if (msg.type === 'task_completed' && msg.data?.task_id === state.currentTaskId) {
        if (global.Tasks) global.Tasks.loadTaskDetail(state.currentTaskId);
      }
    }
    if (msg.type === 'claw_status') {
      state.claw.status = msg.data;
      if (global.Claw) global.Claw.renderClawStatus();
    }
    if (msg.type === 'claw_qrcode') {
      if (state.claw.status) {
        state.claw.status.qrcode_url = msg.data.qrcode_url;
        state.claw.status.qrcode_expires_at = msg.data.expires_at;
      } else {
        state.claw.status = msg.data;
      }
      state.claw.lastQrcodeExpiresAt = msg.data.expires_at;
      if (state.claw.modalOpen && global.Claw) global.Claw.renderWechatModal();
      if (global.Claw) global.Claw.startQrcodeCountdown();
    }
    if (msg.type === 'wechat_message') {
      if (global.Sessions) global.Sessions.loadSessions();
      if (msg.data?.session_id === state.currentSessionId || !state.currentSessionId) {
        if (global.Tasks) global.Tasks.loadTasks();
      }
      showNotification(`💬 微信消息: ${msg.data?.from_user || ''} - ${(msg.data?.content || '').slice(0, 20)}`, 'info', 4000);
    }
    if (msg.type === 'claw_error') {
      showNotification(`⚠️ Claw 错误: ${msg.data?.message || ''}`, 'error', 5000);
    }
  }

  // ======== Heartbeat ========
  function startHeartbeat() {
    if (global.Core.heartbeatInterval) return;
    global.Core.heartbeatInterval = setInterval(async () => {
      try {
        const { data } = await api('/api/heartbeat');
        updateQueueStats(data.queue_stats);
      } catch (e) {
        // 心跳失败：静默处理，避免弹通知刷屏；UI 上有连接状态指示
        if (e.network) {
          // 网络层失败 → 更新连接状态
          const status = document.getElementById('connection-status');
          if (status && status.className === 'status connected') {
            status.className = 'status disconnected';
            status.innerHTML = '● 后端无响应';
          }
        }
      }
    }, 5000);
  }

  // ======== Drawer / Modal ========
  function openDrawer(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
    const overlay = document.getElementById('drawer-overlay');
    if (overlay) overlay.classList.add('open');
  }
  function closeDrawer(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
    const overlay = document.getElementById('drawer-overlay');
    if (overlay) overlay.classList.remove('open');
  }
  function closeAllDrawers() {
    document.querySelectorAll('.drawer.open').forEach(d => d.classList.remove('open'));
    const overlay = document.getElementById('drawer-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function showModal({ title, fields, onSubmit }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">${escapeHtml(title)}</div>
        <div class="modal-body">
          ${fields.map(f => `
            <label>${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>
            ${f.type === 'textarea'
              ? `<textarea name="${f.name}" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(f.value || '')}</textarea>`
              : `<input type="text" name="${f.name}" placeholder="${escapeHtml(f.placeholder || '')}" value="${escapeHtml(f.value || '')}" ${f.required ? 'required' : ''}>`
            }
          `).join('')}
        </div>
        <div class="modal-footer">
          <button class="modal-btn" data-action="cancel">取消</button>
          <button class="modal-btn modal-btn-primary" data-action="confirm">确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
    overlay.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
      const data = {};
      fields.forEach(f => {
        const el = overlay.querySelector(`[name="${f.name}"]`);
        data[f.name] = el ? el.value.trim() : '';
      });
      if (fields.some(f => f.required && !data[f.name])) {
        showNotification('⚠️ 请填写必填项', 'warning');
        return;
      }
      close();
      await onSubmit(data);
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    setTimeout(() => {
      const firstInput = overlay.querySelector('input, textarea');
      if (firstInput) firstInput.focus();
    }, 100);
  }

  // ======== Hash Routing ========
  // setHash 已移到 core.js（v5.2.1），避免 sessions/tasks 在 main.js 之前加载时拿到 undefined
  function handleHashRoute() {
    const h = window.location.hash.slice(1);
    if (!h) return;
    const m = h.match(/^session\/([^/]+)(?:\/task\/(.+))?$/);
    if (m) {
      const sid = m[1];
      const tid = m[2];
      if (state.currentSessionId !== sid && global.Sessions) global.Sessions.selectSession(sid);
      if (tid && global.Tasks) global.Tasks.selectTask(tid);
    }
  }

  // ======== Splitters ========
  let dragging = null;

  function applyColumnWidths() {
    const leftW = localStorage.getItem('col-left-width');
    const rightW = localStorage.getItem('col-right-width');
    if (leftW) document.documentElement.style.setProperty('--col-left-width', leftW + 'px');
    if (rightW) document.documentElement.style.setProperty('--col-right-width', rightW + 'px');
  }

  function bindSplitters() {
    document.querySelectorAll('.splitter-vertical').forEach(splitter => {
      splitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = splitter;
        splitter.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMove = (ev) => {
          if (!dragging) return;
          const splitterId = dragging.id;
          if (splitterId === 'splitter-1') {
            const w = Math.max(180, Math.min(500, ev.clientX));
            document.documentElement.style.setProperty('--col-left-width', w + 'px');
            localStorage.setItem('col-left-width', w);
          } else if (splitterId === 'splitter-2') {
            const w = Math.max(300, Math.min(700, window.innerWidth - ev.clientX));
            document.documentElement.style.setProperty('--col-right-width', w + 'px');
            localStorage.setItem('col-right-width', w);
          }
        };

        const onUp = () => {
          if (dragging) dragging.classList.remove('dragging');
          dragging = null;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // ======== Bind Events ========
  function bindEvents() {
    document.getElementById('btn-open-logs').addEventListener('click', () => {
      openDrawer('log-drawer');
      loadLogsDrawer();
    });
    document.getElementById('btn-open-stats').addEventListener('click', () => {
      openDrawer('stats-drawer');
      loadStatsDrawer();
    });

    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => closeDrawer(btn.dataset.close));
    });
    document.getElementById('drawer-overlay').addEventListener('click', closeAllDrawers);

    document.getElementById('btn-new-session').addEventListener('click', () => {
      if (global.Sessions) global.Sessions.createSession();
    });
    document.getElementById('session-search').addEventListener('input', (e) => {
      state.sessionSearch = e.target.value;
      if (global.Sessions) global.Sessions.loadSessions();
    });
    document.getElementById('session-filter').addEventListener('change', (e) => {
      state.sessionFilter = e.target.value;
      if (global.Sessions) global.Sessions.loadSessions();
    });
    document.getElementById('session-list').addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.action;
        const sid = actionBtn.dataset.sessionId;
        if (!global.Sessions) return;
        if (action === 'rename') global.Sessions.renameSession(sid);
        else if (action === 'archive') global.Sessions.archiveSession(sid);
        else if (action === 'delete') global.Sessions.deleteSession(sid);
        return;
      }
      const item = e.target.closest('[data-session-id]');
      if (item && global.Sessions) global.Sessions.selectSession(item.dataset.sessionId);
    });

    document.getElementById('btn-refresh-tasks').addEventListener('click', () => {
      if (global.Tasks) global.Tasks.loadTasks();
    });
    document.getElementById('task-flow').addEventListener('click', (e) => {
      const card = e.target.closest('[data-task-id]');
      if (card && global.Tasks) global.Tasks.selectTask(card.dataset.taskId);
    });
    document.querySelectorAll('#task-filter-tabs .tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#task-filter-tabs .tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentFilter = tab.dataset.filter;
        if (global.Tasks) global.Tasks.loadTasks();
      });
    });

    document.getElementById('btn-close-detail').addEventListener('click', () => {
      state.currentTaskId = null;
      state.detailTab = 'overview';
      document.getElementById('detail-body').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">👈</div>
          <div class="empty-text">已关闭详情</div>
          <div class="empty-hint">点击任务卡片可重新打开</div>
        </div>`;
      history.pushState('', document.title, window.location.pathname + window.location.search + (state.currentSessionId ? `#session/${state.currentSessionId}` : ''));
    });

    document.getElementById('btn-compose-send').addEventListener('click', () => {
      if (global.Tasks) global.Tasks.submitCompose();
    });
    document.getElementById('compose-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (global.Tasks) global.Tasks.submitCompose();
      }
    });
    document.getElementById('compose-input').addEventListener('input', () => {
      if (global.Tasks) global.Tasks.autoResizeInput();
    });

    document.getElementById('log-level-filter').addEventListener('change', loadLogsDrawer);
    document.getElementById('log-source-filter').addEventListener('change', loadLogsDrawer);

    document.getElementById('btn-export-data').addEventListener('click', exportData);
    document.getElementById('btn-wipe-data').addEventListener('click', wipeData);

    document.getElementById('wechat-status').addEventListener('click', () => {
      if (global.Claw) global.Claw.openWechatModal();
    });
    document.querySelectorAll('#wechat-modal [data-close-modal]').forEach(el => {
      el.addEventListener('click', () => {
        if (global.Claw) global.Claw.closeWechatModal();
      });
    });

    window.addEventListener('hashchange', handleHashRoute);

    bindSplitters();

    document.querySelectorAll('.tab-menu .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllDrawers();
    });
  }

  // ======== Init ========
  function init() {
    // 安装全局错误处理
    if (global.Core.installGlobalErrorHandlers) global.Core.installGlobalErrorHandlers();

    if (global.Sessions) global.Sessions.loadSessions();
    loadStats();
    connectWebSocket();
    startHeartbeat();
    if (global.Claw) global.Claw.loadClawStatus();
    if (global.KB) global.KB.initKB();
    if (global.WF) global.WF.initWF();
    if (global.Plan) global.Plan.initPlan();
    if (global.Plan) global.Plan.initReportDrawer();
    if (global.Plan) global.Plan.startPlanReminderScheduler();
    bindEvents();
    applyColumnWidths();
    const hashTab = (location.hash.match(/^#tab\/(\w+)/) || [])[1];
    switchTab(hashTab || 'chat', { skipHash: true });
  }

  // 暴露到 window
  global.Main = {
    init,
    switchTab,
    updateTabCounts,
    loadStats,
    updateQueueStats,
    loadStatsDrawer,
    exportData,
    wipeData,
    loadLogsDrawer,
    connectWebSocket,
    startHeartbeat,
    openDrawer,
    closeDrawer,
    closeAllDrawers,
    showModal,
    handleHashRoute,
    applyColumnWidths,
    bindEvents
  };

  // 兼容：bindEvents 中可能引用 loadTasks / loadSessions / submitCompose / createSession 等
  global.loadSessions = () => global.Sessions && global.Sessions.loadSessions();
  global.loadTasks = () => global.Tasks && global.Tasks.loadTasks();
  global.submitCompose = () => global.Tasks && global.Tasks.submitCompose();
  global.createSession = () => global.Sessions && global.Sessions.createSession();
  global.renameSession = (id) => global.Sessions && global.Sessions.renameSession(id);
  global.archiveSession = (id) => global.Sessions && global.Sessions.archiveSession(id);
  global.deleteSession = (id) => global.Sessions && global.Sessions.deleteSession(id);
  global.selectSession = (id) => global.Sessions && global.Sessions.selectSession(id);
  global.selectTask = (id) => global.Tasks && global.Tasks.selectTask(id);
  global.loadTaskDetail = (id) => global.Tasks && global.Tasks.loadTaskDetail(id);
  global.updateQueueStats = updateQueueStats;
  global.loadClawStatus = () => global.Claw && global.Claw.loadClawStatus();
  global.openWechatModal = () => global.Claw && global.Claw.openWechatModal();
  global.closeWechatModal = () => global.Claw && global.Claw.closeWechatModal();
  global.renderClawStatus = () => global.Claw && global.Claw.renderClawStatus();
  global.renderWechatModal = () => global.Claw && global.Claw.renderWechatModal();
  global.startQrcodeCountdown = () => global.Claw && global.Claw.startQrcodeCountdown();
  global.initKB = () => global.KB && global.KB.initKB();
  global.initWF = () => global.WF && global.WF.initWF();
  global.initPlan = () => global.Plan && global.Plan.initPlan();
  global.initReportDrawer = () => global.Plan && global.Plan.initReportDrawer();
  global.startPlanReminderScheduler = () => global.Plan && global.Plan.startPlanReminderScheduler();
  global.openWeeklyReportDrawer = () => global.Plan && global.Plan.openWeeklyReportDrawer();
  global.enableCompose = (en) => global.Tasks && global.Tasks.enableCompose(en);

  document.addEventListener('DOMContentLoaded', init);
})(window);
