// ======== v3.0.0 Three-Column Workspace ========

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

// ======== State ========
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
    lastQrcodeExpiresAt: null
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

let ws = null;
let reconnectTimer = null;
let heartbeatInterval = null;

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

function showNotification(msg, type = 'info', duration = 3000) {
  const container = document.getElementById('notification-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

async function api(path, options = {}) {
  const opts = { headers: { 'Content-Type': 'application/json' }, ...options };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const resp = await fetch(path, opts);
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
}

// ======== Init ========
function init() {
  loadSessions();
  loadStats();
  connectWebSocket();
  startHeartbeat();
  loadClawStatus();  // v4.0.0
  initKB();          // 知识库 v4.1.0（修复为新结构）
  initWF();          // v4.2.1 工作流
  initPlan();        // v5.1.0 计划
  initReportDrawer(); // v5.1.1 周报生成器
  bindEvents();
  applyColumnWidths();
  // 从 hash 恢复 tab 状态，默认 chat
  const hashTab = (location.hash.match(/^#tab\/(\w+)/) || [])[1];
  switchTab(hashTab || 'chat', { skipHash: true });
}

// ======== v4.2.1 顶部 Tab 切换 ========
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

  // 1) 切换 tab-btn 激活态
  document.querySelectorAll('.tab-menu .tab-btn').forEach(btn => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // 2) 切换 panel 可见性（重新触发动画）
  Object.entries(TAB_PANELS).forEach(([key, panelId]) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    if (key === tabName) {
      panel.style.display = '';
      panel.hidden = false;
      // 强制 reflow 重启动画
      panel.style.animation = 'none';
      void panel.offsetWidth;
      panel.style.animation = '';
    } else {
      panel.style.display = 'none';
      panel.hidden = true;
    }
  });

  // 3) 懒初始化：首次进入面板时执行
  if (previous !== tabName && TAB_INIT[tabName]) {
    const initFn = window[TAB_INIT[tabName]];
    if (typeof initFn === 'function') initFn();
  }

  // 4) 更新 tab 计数徽章
  updateTabCounts();

  // 5) 更新 hash
  if (!opts.skipHash && location.hash !== `#tab/${tabName}`) {
    history.replaceState(null, '', `#tab/${tabName}`);
  }
}

function updateTabCounts() {
  // 聊天：当前会话的任务数
  const chatCount = document.getElementById('tab-count-chat');
  if (chatCount) {
    const n = (state.tasks || []).length;
    if (n > 0) {
      chatCount.textContent = n;
      chatCount.hidden = false;
    } else {
      chatCount.hidden = true;
    }
  }
  // 知识库：当前分类条目数（无分类时显示总数）
  const kbCount = document.getElementById('tab-count-kb');
  if (kbCount) {
    const n = (state.kbItems || []).length;
    if (n > 0) {
      kbCount.textContent = n;
      kbCount.hidden = false;
    } else {
      kbCount.hidden = true;
    }
  }
  // 工作流：工作流模板数
  const wfCount = document.getElementById('tab-count-wf');
  if (wfCount) {
    const n = (state.workflows || []).length;
    if (n > 0) {
      wfCount.textContent = n;
      wfCount.hidden = false;
    } else {
      wfCount.hidden = true;
    }
  }
  // 计划：计划条目数
  const planCount = document.getElementById('tab-count-plan');
  if (planCount) {
    const n = (state.plans || []).length;
    if (n > 0) {
      planCount.textContent = n;
      planCount.hidden = false;
    } else {
      planCount.hidden = true;
    }
  }
}

// ======== Sessions ========
async function loadSessions() {
  try {
    const params = new URLSearchParams();
    if (state.sessionFilter && state.sessionFilter !== 'all') params.set('status', state.sessionFilter);
    if (state.sessionSearch) params.set('q', state.sessionSearch);
    const { data } = await api(`/api/sessions?${params}`);
    state.sessions = data;
    renderSessions();
    document.getElementById('sessions-count').textContent = `会话: ${data.length}`;
  } catch (e) {
    console.error('loadSessions:', e);
  }
}

function renderSessions() {
  const container = document.getElementById('session-list');
  if (!state.sessions.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <div class="empty-text">暂无会话</div>
        <div class="empty-hint">点击右上角 ＋ 新建</div>
      </div>`;
    return;
  }

  container.innerHTML = state.sessions.map(s => {
    const isActive = s.id === state.currentSessionId;
    const isDefault = s.id === 'sess-default' || s.meta?.is_default;
    return `
      <div class="session-item ${isActive ? 'active' : ''} ${s.status === 'archived' ? 'archived' : ''} ${isDefault ? 'default' : ''}"
           data-session-id="${s.id}">
        <div class="session-item-header">
          <div class="session-item-name">${escapeHtml(s.name)}</div>
          <div class="session-item-count">${s.task_count || 0}</div>
        </div>
        ${s.last_task_summary ? `<div class="session-item-summary">${escapeHtml(s.last_task_summary)}</div>` : ''}
        <div class="session-item-time">${formatRelative(s.updated_at)}</div>
        ${!isDefault ? `
        <div class="session-item-actions">
          <button class="session-action-btn" data-action="rename" data-session-id="${s.id}" title="重命名">✎</button>
          <button class="session-action-btn" data-action="archive" data-session-id="${s.id}" title="归档">📦</button>
          <button class="session-action-btn danger" data-action="delete" data-session-id="${s.id}" title="删除">🗑</button>
        </div>` : ''}
      </div>`;
  }).join('');
}

function selectSession(sessionId) {
  state.currentSessionId = sessionId;
  state.currentTaskId = null;
  renderSessions();
  loadTasks();
  enableCompose(true);
  document.getElementById('middle-title').textContent =
    `📌 ${state.sessions.find(s => s.id === sessionId)?.name || '任务流'}`;
  // 关闭详情或显示空状态
  document.getElementById('detail-body').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">👈</div>
      <div class="empty-text">选择任务查看详情</div>
      <div class="empty-hint">点击中间栏的任务卡片</div>
    </div>`;
  setHash(`#session/${sessionId}`);
}

async function createSession() {
  showModal({
    title: '新建会话',
    fields: [
      { name: 'name', label: '会话名称', placeholder: '如：商品价格监控', required: true },
      { name: 'description', label: '描述（可选）', type: 'textarea', placeholder: '会话用途备注' }
    ],
    onSubmit: async (data) => {
      try {
        const { data: session } = await api('/api/sessions', { method: 'POST', body: data });
        showNotification(`✅ 会话已创建: ${session.name}`, 'success');
        await loadSessions();
        selectSession(session.id);
      } catch (e) {
        showNotification(`❌ 创建失败: ${e.message}`, 'error');
      }
    }
  });
}

async function renameSession(sessionId) {
  const s = state.sessions.find(s => s.id === sessionId);
  if (!s) return;
  showModal({
    title: '重命名会话',
    fields: [
      { name: 'name', label: '会话名称', value: s.name, required: true },
      { name: 'description', label: '描述（可选）', type: 'textarea', value: s.description || '' }
    ],
    onSubmit: async (data) => {
      try {
        await api(`/api/sessions/${sessionId}`, { method: 'PATCH', body: data });
        showNotification('✅ 已重命名', 'success');
        await loadSessions();
      } catch (e) {
        showNotification(`❌ 失败: ${e.message}`, 'error');
      }
    }
  });
}

async function archiveSession(sessionId) {
  if (!confirm('归档此会话？\n（任务保留，可在归档列表查看）')) return;
  try {
    await api(`/api/sessions/${sessionId}`, { method: 'PATCH', body: { status: 'archived' } });
    showNotification('📦 已归档', 'success');
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = null;
      enableCompose(false);
    }
    await loadSessions();
  } catch (e) {
    showNotification(`❌ 失败: ${e.message}`, 'error');
  }
}

async function deleteSession(sessionId) {
  if (!confirm('删除此会话？\n（其任务会重新归属到默认会话，数据不丢失）')) return;
  try {
    const { data } = await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    showNotification(`🗑 已删除，${data.reassigned_tasks} 个任务已重新归属`, 'success');
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = 'sess-default';
      await loadSessions();
      selectSession('sess-default');
    } else {
      await loadSessions();
    }
  } catch (e) {
    showNotification(`❌ 失败: ${e.message}`, 'error');
  }
}

// ======== Tasks ========
async function loadTasks() {
  if (!state.currentSessionId) {
    state.tasks = [];
    renderTasks();
    return;
  }
  try {
    const params = new URLSearchParams();
    params.set('session_id', state.currentSessionId);
    params.set('limit', '100');
    if (state.currentFilter && state.currentFilter !== 'all') {
      // v5.1.1: 「处理中」tab 同时匹配 assigned + processing 两种状态
      if (state.currentFilter === 'processing') {
        params.set('status', 'assigned,processing');
      } else {
        params.set('status', state.currentFilter);
      }
    }
    const { data, meta } = await api(`/api/tasks?${params}`);
    state.tasks = data;
    renderTasks();
    if (meta?.queue_stats) updateQueueStats(meta.queue_stats);
  } catch (e) {
    console.error('loadTasks:', e);
  }
}

function renderTasks() {
  const container = document.getElementById('task-flow');
  if (!state.tasks.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-text">该会话暂无任务</div>
        <div class="empty-hint">在下方输入消息创建</div>
      </div>`;
    return;
  }

  container.innerHTML = state.tasks.map(t => {
    const isSelected = t.id === state.currentTaskId;
    const source = t.source || 'manual';
    const sourceLabel = i18n('source', source);
    return `
      <div class="task-card status-${t.status} ${isSelected ? 'selected' : ''}" data-task-id="${t.id}" data-source="${escapeHtml(source)}">
        <div class="task-card-header">
          <div class="task-card-id">${escapeHtml(t.id)}<span class="source-badge source-${escapeHtml(source)}">${escapeHtml(sourceLabel)}</span></div>
          <span class="badge badge-${t.status}">${i18n('status', t.status)}</span>
        </div>
        <div class="task-card-content">${escapeHtml(t.data?.content || '(无内容)')}</div>
        <div class="task-card-meta">
          <span class="badge badge-priority-${t.priority}">${i18n('priority', t.priority)}</span>
          <span>${i18n('type', t.type)}</span>
          <span>·</span>
          <span>${formatRelative(t.created_at)}</span>
        </div>
      </div>`;
  }).join('');
}

function selectTask(taskId) {
  state.currentTaskId = taskId;
  renderTasks();
  loadTaskDetail(taskId);
  setHash(`#session/${state.currentSessionId}/task/${taskId}`);
}

async function loadTaskDetail(taskId) {
  const body = document.getElementById('detail-body');
  body.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">加载中...</div></div>`;

  try {
    const { data: task } = await api(`/api/tasks/${taskId}`);
    renderDetail(task);
  } catch (e) {
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-text">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderDetail(task) {
  const body = document.getElementById('detail-body');
  const result = task.result;
  const evidence = result?.evidence;

  body.innerHTML = `
    <div class="detail-tabs">
      <button class="detail-tab ${state.detailTab === 'overview' ? 'active' : ''}" data-tab="overview">概览</button>
      <button class="detail-tab ${state.detailTab === 'evidence' ? 'active' : ''}" data-tab="evidence">依据</button>
      <button class="detail-tab ${state.detailTab === 'timeline' ? 'active' : ''}" data-tab="timeline">时间</button>
    </div>
    <div class="col-body" style="padding: 14px 16px;">
      <div id="detail-tab-content"></div>
    </div>
  `;

  // Tab 切换
  body.querySelectorAll('.detail-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.detailTab = btn.dataset.tab;
      renderDetail(task);
    });
  });

  const content = body.querySelector('#detail-tab-content');
  if (state.detailTab === 'overview') {
    content.innerHTML = renderDetailOverview(task, result);
    bindDetailActions(task);
  } else if (state.detailTab === 'evidence') {
    content.innerHTML = renderDetailEvidence(evidence);
  } else if (state.detailTab === 'timeline') {
    content.innerHTML = renderDetailTimeline(task);
  }
}

function renderWechatSourceSection(task) {
  const ctx = task.context || {};
  const fromUser = task.data?.from_user || '-';
  const wxid = ctx.wechat_wxid || '-';
  const msgId = ctx.wechat_msg_id || '-';
  const type = ctx.wechat_type || 'text';
  const room = ctx.wechat_room || '-';
  const ts = ctx.wechat_timestamp
    ? new Date(ctx.wechat_timestamp).toLocaleString()
    : '-';
  return `
    <div class="wechat-source-section">
      <h4>📱 微信来源</h4>
      <div class="ws-grid">
        <div class="ws-label">发送者</div>
        <div class="ws-value">${escapeHtml(fromUser)} (${escapeHtml(wxid)})</div>
        <div class="ws-label">消息ID</div>
        <div class="ws-value">${escapeHtml(msgId)}</div>
        <div class="ws-label">消息类型</div>
        <div class="ws-value">${escapeHtml(type)}</div>
        <div class="ws-label">群聊</div>
        <div class="ws-value ${room === '-' ? 'empty' : ''}">${escapeHtml(room)}</div>
        <div class="ws-label">原始时间</div>
        <div class="ws-value">${escapeHtml(ts)}</div>
      </div>
      <div class="ws-actions">
        <button onclick="copyToClipboard('${escapeHtml(msgId)}', 'msgId')">📋 复制 msgId</button>
        <button onclick="copyToClipboard('${escapeHtml(wxid)}', 'wxid')">📋 复制 wxid</button>
      </div>
    </div>
  `;
}

function copyToClipboard(text, label) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => showNotification(`✓ ${label} 已复制`, 'success', 1500),
      () => showNotification(`❌ 复制失败`, 'error')
    );
  } else {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showNotification(`✓ ${label} 已复制`, 'success', 1500); }
    catch { showNotification(`❌ 复制失败`, 'error'); }
    ta.remove();
  }
}

function renderDetailOverview(task, result) {
  return `
    <div class="detail-meta">
      <div class="detail-meta-item">
        <span class="detail-meta-label">ID</span>
        <span class="detail-meta-value" style="font-family: monospace; font-size: 10px;">${escapeHtml(task.id)}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">状态</span>
        <span class="badge badge-${task.status}">${i18n('status', task.status)}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">类型</span>
        <span class="detail-meta-value">${i18n('type', task.type)}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">优先级</span>
        <span class="badge badge-priority-${task.priority}">${i18n('priority', task.priority)}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">来源</span>
        <span class="detail-meta-value">${i18n('source', task.source)}${task.source === 'wechat' && task.status === 'completed' ? '<span class="reply-status success">✓ 已回复</span>' : ''}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">会话</span>
        <span class="detail-meta-value" style="font-family: monospace; font-size: 10px;">${escapeHtml(task.session_id || 'sess-default')}</span>
      </div>
    </div>

    ${task.source === 'wechat' ? renderWechatSourceSection(task) : ''}

    <div class="detail-section">
      <h3>📌 任务内容</h3>
      <div class="detail-content">${escapeHtml(task.data?.content || '')}</div>
    </div>

    ${result ? `
    <div class="detail-section">
      <h3>✅ 结论</h3>
      <div class="detail-summary">${escapeHtml(result.result?.summary || '无摘要')}</div>
      ${result.result?.details ? `<div class="detail-content" style="margin-top: 8px; border-left-color: var(--success);">${escapeHtml(result.result.details)}</div>` : ''}
    </div>
    ` : `
    <div class="detail-section">
      <h3>✅ 结论</h3>
      <div class="detail-empty">尚未完成（状态：${task.status}）</div>
    </div>
    `}

    <div class="detail-actions">
      ${task.status === 'failed' || task.status === 'completed' ? `<button class="detail-action-btn" data-action="retry">🔄 重试</button>` : ''}
      <button class="detail-action-btn danger" data-action="delete">🗑 删除</button>
    </div>
  `;
}

function renderDetailEvidence(evidence) {
  if (!evidence) {
    return `<div class="detail-empty">智能体未提交执行依据</div>`;
  }

  const cmds = evidence.executed_commands || [];
  const files = evidence.read_files || [];
  const searches = evidence.searches || [];
  const tools = evidence.tool_calls || [];

  let html = '<div class="evidence">';

  html += `<details ${cmds.length ? 'open' : ''}><summary>💻 执行的命令 <span class="evidence-count">${cmds.length}</span></summary>`;
  if (cmds.length === 0) html += `<div class="evidence-content"><div class="detail-empty">无</div></div>`;
  else html += `<div class="evidence-content">${cmds.map(c => `
    <div class="evidence-item cmd">
      <div class="label">$ ${escapeHtml(c.cmd)}</div>
      <div class="output">${escapeHtml(c.output_summary || '')}</div>
      <div class="meta">⏰ ${formatTime(c.at)}</div>
    </div>`).join('')}</div>`;
  html += `</details>`;

  html += `<details ${files.length ? 'open' : ''}><summary>📂 读取的文件 <span class="evidence-count">${files.length}</span></summary>`;
  if (files.length === 0) html += `<div class="evidence-content"><div class="detail-empty">无</div></div>`;
  else html += `<div class="evidence-content">${files.map(f => `
    <div class="evidence-item file">
      <div class="label">📄 ${escapeHtml(f.path)}</div>
      <div class="output">${escapeHtml(f.purpose || '')}</div>
      <div class="meta">⏰ ${formatTime(f.at)}</div>
    </div>`).join('')}</div>`;
  html += `</details>`;

  html += `<details><summary>🔍 搜索 <span class="evidence-count">${searches.length}</span></summary>`;
  if (searches.length === 0) html += `<div class="evidence-content"><div class="detail-empty">无</div></div>`;
  else html += `<div class="evidence-content">${searches.map(s => `
    <div class="evidence-item search">
      <div class="label">🔎 ${escapeHtml(s.query)}</div>
      <div class="meta">引擎: ${escapeHtml(s.engine)} · ⏰ ${formatTime(s.at)}</div>
    </div>`).join('')}</div>`;
  html += `</details>`;

  html += `<details><summary>🛠 工具调用 <span class="evidence-count">${tools.length}</span></summary>`;
  if (tools.length === 0) html += `<div class="evidence-content"><div class="detail-empty">无</div></div>`;
  else html += `<div class="evidence-content">${tools.map(t => `
    <div class="evidence-item tool">
      <div class="label">🛠 ${escapeHtml(t.tool)}</div>
      <div class="output">args: ${escapeHtml(JSON.stringify(t.args || {}))}</div>
      <div class="output">→ ${escapeHtml(t.result_summary || '')}</div>
      <div class="meta">⏰ ${formatTime(t.at)}</div>
    </div>`).join('')}</div>`;
  html += `</details>`;

  html += '</div>';

  if (evidence.thinking && evidence.thinking.trim()) {
    html += `<div class="evidence-thinking"><strong>💭 推理思路：</strong><br>${escapeHtml(evidence.thinking)}</div>`;
  }

  return html;
}

function renderDetailTimeline(task) {
  const events = [
    { ts: task.created_at, label: '任务创建', type: 'create' },
    { ts: task.started_at, label: `分配给 ${task.assigned_to || 'agent'}`, type: 'assign' },
    { ts: task.completed_at, label: `完成（${task.status}）`, type: 'complete' }
  ].filter(e => e.ts);

  return `
    <div class="timeline">
      ${events.map(e => `
        <div class="timeline-item">
          <div class="timeline-time">${formatTime(e.ts)}</div>
          <div class="timeline-label">${escapeHtml(e.label)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function bindDetailActions(task) {
  document.querySelectorAll('#detail-tab-content .detail-action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      if (action === 'retry') {
        try {
          await api(`/api/tasks/${task.id}/retry`, { method: 'POST' });
          showNotification('🔄 已重试', 'success');
          await loadTasks();
        } catch (e) {
          showNotification(`❌ ${e.message}`, 'error');
        }
      } else if (action === 'delete') {
        if (!confirm('删除此任务？')) return;
        try {
          await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
          showNotification('🗑 已删除', 'success');
          state.currentTaskId = null;
          await loadTasks();
          document.getElementById('detail-body').innerHTML = `
            <div class="empty-state">
              <div class="empty-icon">👈</div>
              <div class="empty-text">任务已删除</div>
            </div>`;
        } catch (e) {
          showNotification(`❌ ${e.message}`, 'error');
        }
      }
    });
  });
}

// ======== Compose ========
function enableCompose(enabled) {
  ['compose-input', 'compose-type', 'compose-priority', 'btn-compose-send'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
  const input = document.getElementById('compose-input');
  if (input) {
    input.placeholder = enabled
      ? '输入消息或任务... (Enter 发送，Shift+Enter 换行)'
      : '请先在左侧选择或新建会话';
  }
}

async function submitCompose() {
  if (!state.currentSessionId) {
    showNotification('⚠️ 请先选择或新建会话', 'warning');
    return;
  }
  const input = document.getElementById('compose-input');
  const content = input.value.trim();
  if (!content) return;

  const type = document.getElementById('compose-type').value;
  const priority = document.getElementById('compose-priority').value;

  try {
    await api('/api/tasks', {
      method: 'POST',
      body: {
        content,
        type,
        priority,
        session_id: state.currentSessionId
      }
    });
    input.value = '';
    autoResizeInput();
    showNotification('✅ 已入队', 'success', 1500);
    await loadTasks();
    await loadSessions(); // 刷新会话 task_count
  } catch (e) {
    showNotification(`❌ 发送失败: ${e.message}`, 'error');
  }
}

function autoResizeInput() {
  const input = document.getElementById('compose-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
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
  document.getElementById('queue-stats').textContent =
    `队列: ${stats.pending || 0}待 / ${stats.processing || 0}处 / ${stats.completed || 0}完 / ${stats.failed || 0}败`;
}

async function loadStatsDrawer() {
  const body = document.getElementById('stats-drawer-body');
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

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
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
    enableCompose(false);
    await loadSessions();
    await loadTasks();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

// ======== Logs (Drawer) ========
async function loadLogsDrawer() {
  const level = document.getElementById('log-level-filter').value;
  const source = document.getElementById('log-source-filter').value;
  const params = new URLSearchParams();
  if (level) params.set('level', level);
  if (source) params.set('source', source);
  params.set('limit', '200');

  const body = document.getElementById('log-drawer-list');
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

// ======== WebSocket ========
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    document.getElementById('connection-status').className = 'status connected';
    document.getElementById('connection-status').innerHTML = '● 已连接';
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  ws.onclose = () => {
    document.getElementById('connection-status').className = 'status disconnected';
    document.getElementById('connection-status').innerHTML = '● 已断开';
    reconnectTimer = setTimeout(connectWebSocket, 5000);
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWSMessage(msg);
    } catch (err) {}
  };
}

function handleWSMessage(msg) {
  if (msg.type === 'task_added' || msg.type === 'task_assigned' || msg.type === 'task_completed' || msg.type === 'task_deleted') {
    if (state.currentSessionId && (msg.data?.session_id === state.currentSessionId || msg.data?.task_id === state.currentTaskId)) {
      loadTasks();
    }
    loadSessions(); // 更新 task_count
    if (msg.type === 'task_completed' && msg.data?.task_id === state.currentTaskId) {
      loadTaskDetail(state.currentTaskId);
    }
  }
  // ====== v4.0.0 Claw 事件 ======
  if (msg.type === 'claw_status') {
    state.claw.status = msg.data;
    renderClawStatus();
  }
  if (msg.type === 'claw_qrcode') {
    if (state.claw.status) {
      state.claw.status.qrcode_url = msg.data.qrcode_url;
      state.claw.status.qrcode_expires_at = msg.data.expires_at;
    } else {
      state.claw.status = msg.data;
    }
    state.claw.lastQrcodeExpiresAt = msg.data.expires_at;
    if (state.claw.modalOpen) renderWechatModal();
    startQrcodeCountdown();
  }
  if (msg.type === 'wechat_message') {
    // 收到新微信消息：刷新会话和任务列表
    loadSessions();
    if (msg.data?.session_id === state.currentSessionId || !state.currentSessionId) {
      loadTasks();
    }
    showNotification(`💬 微信消息: ${msg.data?.from_user || ''} - ${(msg.data?.content || '').slice(0, 20)}`, 'info', 4000);
  }
  if (msg.type === 'claw_error') {
    showNotification(`⚠️ Claw 错误: ${msg.data?.message || ''}`, 'error', 5000);
  }
}

// ======== Heartbeat ========
function startHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(async () => {
    try {
      const { data } = await api('/api/heartbeat');
      updateQueueStats(data.queue_stats);
    } catch {}
  }, 5000);
}

// ======== Drawer ========
function openDrawer(id) {
  document.getElementById(id).classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
}
function closeDrawer(id) {
  document.getElementById(id).classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
}
function closeAllDrawers() {
  document.querySelectorAll('.drawer.open').forEach(d => d.classList.remove('open'));
  document.getElementById('drawer-overlay').classList.remove('open');
}

// ======== Modal ========
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

  // ESC 关闭
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  // 自动聚焦第一个输入
  setTimeout(() => {
    const firstInput = overlay.querySelector('input, textarea');
    if (firstInput) firstInput.focus();
  }, 100);
}

// ======== Hash Routing ========
function setHash(hash) {
  if (window.location.hash === hash) return;
  history.pushState('', document.title, window.location.pathname + window.location.search + hash);
}

function handleHashRoute() {
  const h = window.location.hash.slice(1);
  if (!h) return;
  const m = h.match(/^session\/([^/]+)(?:\/task\/(.+))?$/);
  if (m) {
    const sid = m[1];
    const tid = m[2];
    if (state.currentSessionId !== sid) selectSession(sid);
    if (tid) selectTask(tid);
  }
}

// ======== Splitters (拖拽分隔条) ========
let dragging = null;

function applyColumnWidths() {
  // 从 localStorage 恢复
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
  // 头部按钮
  document.getElementById('btn-open-logs').addEventListener('click', () => {
    openDrawer('log-drawer');
    loadLogsDrawer();
  });
  document.getElementById('btn-open-stats').addEventListener('click', () => {
    openDrawer('stats-drawer');
    loadStatsDrawer();
  });

  // 抽屉关闭
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeDrawer(btn.dataset.close));
  });
  document.getElementById('drawer-overlay').addEventListener('click', closeAllDrawers);

  // 会话列表
  document.getElementById('btn-new-session').addEventListener('click', createSession);
  document.getElementById('session-search').addEventListener('input', (e) => {
    state.sessionSearch = e.target.value;
    loadSessions();
  });
  document.getElementById('session-filter').addEventListener('change', (e) => {
    state.sessionFilter = e.target.value;
    loadSessions();
  });
  document.getElementById('session-list').addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      const sid = actionBtn.dataset.sessionId;
      if (action === 'rename') renameSession(sid);
      else if (action === 'archive') archiveSession(sid);
      else if (action === 'delete') deleteSession(sid);
      return;
    }
    const item = e.target.closest('[data-session-id]');
    if (item) selectSession(item.dataset.sessionId);
  });

  // 任务流
  document.getElementById('btn-refresh-tasks').addEventListener('click', loadTasks);
  document.getElementById('task-flow').addEventListener('click', (e) => {
    const card = e.target.closest('[data-task-id]');
    if (card) selectTask(card.dataset.taskId);
  });
  document.querySelectorAll('#task-filter-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#task-filter-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.currentFilter = tab.dataset.filter;
      loadTasks();
    });
  });

  // 关闭详情
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

  // 输入区
  document.getElementById('btn-compose-send').addEventListener('click', submitCompose);
  document.getElementById('compose-input').addEventListener('keydown', (e) => {
    // Enter 发送，Shift+Enter 换行（与主流 IM 一致）
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitCompose();
    }
  });
  document.getElementById('compose-input').addEventListener('input', autoResizeInput);

  // 日志过滤
  document.getElementById('log-level-filter').addEventListener('change', loadLogsDrawer);
  document.getElementById('log-source-filter').addEventListener('change', loadLogsDrawer);

  // 存储抽屉
  document.getElementById('btn-export-data').addEventListener('click', exportData);
  document.getElementById('btn-wipe-data').addEventListener('click', wipeData);

  // v4.0.0 WeChat Claw
  document.getElementById('wechat-status').addEventListener('click', openWechatModal);
  document.querySelectorAll('#wechat-modal [data-close-modal]').forEach(el => {
    el.addEventListener('click', closeWechatModal);
  });

  // Hash 路由
  window.addEventListener('hashchange', handleHashRoute);

  // 分隔条
  bindSplitters();

  // v4.2.1 顶部 tab 菜单切换
  document.querySelectorAll('.tab-menu .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ESC 关闭抽屉
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllDrawers();
    }
  });
}

// ======== Start ========
document.addEventListener('DOMContentLoaded', init);

// ======== v4.0.0 WeChat Claw ========

// 加载/刷新微信连接状态
async function loadClawStatus() {
  try {
    const { data } = await api('/api/claw/status');
    state.claw.status = data;
    renderClawStatus();
  } catch (e) {
    console.error('loadClawStatus:', e);
  }
}

// 渲染顶栏状态徽章
function renderClawStatus() {
  const badge = document.getElementById('wechat-status');
  if (!badge) return;
  const status = state.claw.status;
  if (!status) {
    badge.setAttribute('data-state', 'disconnected');
    badge.querySelector('.ws-text').textContent = '微信加载中';
    return;
  }

  badge.setAttribute('data-state', status.state);
  const textEl = badge.querySelector('.ws-text');
  switch (status.state) {
    case 'disconnected':
      textEl.textContent = '微信未连接';
      break;
    case 'qrcode':
      textEl.textContent = '等待扫码';
      break;
    case 'connecting':
      textEl.textContent = '连接中…';
      break;
    case 'connected':
      textEl.textContent = status.nickname || status.wxid || '已连接';
      break;
    case 'reconnecting':
      textEl.textContent = '重新连接…';
      break;
    case 'banned':
      textEl.textContent = '⚠️ 封号';
      break;
    case 'error':
      textEl.textContent = '⚠️ 异常';
      break;
    default:
      textEl.textContent = status.state;
  }
}

// 打开微信管理弹窗
async function openWechatModal() {
  state.claw.modalOpen = true;
  document.getElementById('wechat-modal').hidden = false;
  await loadClawStatus();
  renderWechatModal();
}

// 关闭弹窗
function closeWechatModal() {
  state.claw.modalOpen = false;
  document.getElementById('wechat-modal').hidden = true;
  if (state.claw.qrcodeTimer) {
    clearInterval(state.claw.qrcodeTimer);
    state.claw.qrcodeTimer = null;
  }
}

// 渲染弹窗内容
function renderWechatModal() {
  const body = document.getElementById('wechat-modal-body');
  const footer = document.getElementById('wechat-modal-footer');
  const status = state.claw.status;
  if (!status) {
    body.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">加载中...</div></div>';
    footer.innerHTML = '';
    return;
  }

  if (status.state === 'qrcode' && status.qrcode_url) {
    // 二维码视图
    const expires = status.qrcode_expires_at || 0;
    const remaining = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    // iLink 返回的是微信深链（不能直接当图片渲染），由后端 /api/claw/qrcode.png 转码为 PNG
    const pngSrc = `/api/claw/qrcode.png?_=${Date.now()}`;
    body.innerHTML = `
      <div class="qrcode-container">
        <img src="${pngSrc}" alt="QR Code" class="qrcode-img"
             onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='block';" />
        <div class="qrcode-fallback" style="display:none;">
          <div class="qrcode-tip">⚠️ 图片加载失败，请用下方深链</div>
          <div class="qrcode-link">${escapeHtml(status.qrcode_url)}</div>
        </div>
        <div class="qrcode-tip">📱 请用微信扫描二维码登录</div>
        <div class="qrcode-countdown" id="qrcode-countdown">⏱ 二维码 ${remaining} 秒后过期</div>
        <details class="qrcode-deep-link">
          <summary>深链（备选）</summary>
          <code>${escapeHtml(status.qrcode_url)}</code>
        </details>
      </div>`;
    footer.innerHTML = `
      <button onclick="closeWechatModal()">关闭</button>
      <button class="primary" onclick="refreshClawQrcode()">🔄 刷新二维码</button>`;
  } else if (status.state === 'connected') {
    // 已连接视图
    body.innerHTML = `
      <div class="claw-state-display">
        <div class="state-icon">✅</div>
        <div class="state-text">已登录</div>
        <div class="state-sub">${escapeHtml(status.nickname || '')} ${status.wxid ? `(${escapeHtml(status.wxid)})` : ''}</div>
      </div>
      <div class="claw-info">
        <div class="ci-label">昵称</div><div class="ci-value">${escapeHtml(status.nickname || '-')}</div>
        <div class="ci-label">wxid</div><div class="ci-value">${escapeHtml(status.wxid || '-')}</div>
        <div class="ci-label">adapter</div><div class="ci-value">${escapeHtml(status.adapter_name || '-')}</div>
        <div class="ci-label">连接时间</div><div class="ci-value">${status.connected_at ? new Date(status.connected_at).toLocaleString() : '-'}</div>
      </div>`;
    footer.innerHTML = `
      <button class="danger" onclick="logoutClaw()">退出登录</button>
      <button onclick="restartClaw()">🔄 重启</button>
      <button class="primary" onclick="closeWechatModal()">完成</button>`;
  } else if (status.state === 'disconnected') {
    body.innerHTML = `
      <div class="claw-state-display">
        <div class="state-icon">📱</div>
        <div class="state-text">微信未连接</div>
        <div class="state-sub">点击下方"开始登录"扫码连接</div>
      </div>`;
    footer.innerHTML = `
      <button onclick="closeWechatModal()">关闭</button>
      <button class="primary" onclick="startClawLogin()">🚀 开始登录</button>`;
  } else if (status.state === 'error' || status.state === 'banned') {
    body.innerHTML = `
      <div class="claw-state-display">
        <div class="state-icon">⚠️</div>
        <div class="state-text" style="color: var(--danger);">${status.state === 'banned' ? '账号被封' : '连接异常'}</div>
        <div class="state-sub">${escapeHtml(status.error_message || '请检查 gewechat 服务')}</div>
      </div>`;
    footer.innerHTML = `
      <button onclick="closeWechatModal()">关闭</button>
      <button class="primary" onclick="startClawLogin()">🔄 重试</button>`;
  } else {
    body.innerHTML = `
      <div class="claw-state-display">
        <div class="state-icon">⏳</div>
        <div class="state-text">${escapeHtml(status.state)}</div>
        <div class="state-sub">${escapeHtml(status.error_message || '')}</div>
      </div>`;
    footer.innerHTML = '<button onclick="closeWechatModal()">关闭</button>';
  }
}

// 二维码倒计时
function startQrcodeCountdown() {
  if (state.claw.qrcodeTimer) clearInterval(state.claw.qrcodeTimer);
  state.claw.qrcodeTimer = setInterval(() => {
    if (!state.claw.modalOpen) {
      clearInterval(state.claw.qrcodeTimer);
      state.claw.qrcodeTimer = null;
      return;
    }
    const expires = state.claw.lastQrcodeExpiresAt;
    if (!expires) return;
    const remaining = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    const el = document.getElementById('qrcode-countdown');
    if (el) {
      el.textContent = remaining > 0
        ? `⏱ 二维码 ${remaining} 秒后过期`
        : '❌ 二维码已过期，点击"刷新"重新获取';
      el.classList.toggle('expired', remaining === 0);
    }
  }, 1000);
}

// 触发登录
async function startClawLogin() {
  try {
    showNotification('⏳ 正在生成二维码...', 'info', 2000);
    await api('/api/claw/login/start', { method: 'POST', body: {} });
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

// 刷新二维码
async function refreshClawQrcode() {
  try {
    await api('/api/claw/login/start', { method: 'POST', body: {} });
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

// 退出登录
async function logoutClaw() {
  if (!confirm('确认退出微信登录？')) return;
  try {
    await api('/api/claw/logout', { method: 'POST', body: {} });
    showNotification('✓ 已退出', 'success');
    await loadClawStatus();
    renderWechatModal();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

// 重启 adapter
async function restartClaw() {
  if (!confirm('确认重启 Claw？')) return;
  try {
    await api('/api/claw/restart', { method: 'POST', body: {} });
    showNotification('✓ 已重启', 'success');
    await loadClawStatus();
    renderWechatModal();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

// ======== Knowledge Base (v4.1.0) ========
// 状态、加载、渲染、CRUD、就地编辑、点击填入聊天、localStorage 记忆

const KB_STORAGE_KEY = 'kb-state-v1';
const kbState = {
  categories: [],
  items: [],
  searchKeyword: '',
  expanded: {},   // { [categoryId]: bool }
  collapsed: false,  // 整列是否收起
  scrollTop: 0
};

function loadKBState() {
  try {
    const raw = localStorage.getItem(KB_STORAGE_KEY);
    if (raw) Object.assign(kbState, JSON.parse(raw));
  } catch (e) {
    console.warn('loadKBState:', e);
  }
}

function saveKBState() {
  try {
    localStorage.setItem(KB_STORAGE_KEY, JSON.stringify({
      searchKeyword: kbState.searchKeyword,
      expanded: kbState.expanded,
      collapsed: kbState.collapsed,
      scrollTop: kbState.scrollTop
    }));
  } catch (e) {
    console.warn('saveKBState:', e);
  }
}

async function initKB() {
  bindKBEvents();
  await loadKB();
}

// ======== v4.2.1 知识库（匹配新 DOM：kb-side + kb-main + 抽屉） ========
function bindKBEvents() {
  // 视图切换（列表 / 图谱）
  document.querySelectorAll('#kb-view-tabs .tab').forEach(t => {
    t.addEventListener('click', () => switchKBView(t.dataset.view));
  });
  // 搜索
  const search = document.getElementById('kb-search');
  if (search) {
    let timer;
    search.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        kbState.searchKeyword = e.target.value.trim();
        renderKB();
        if (state.kbView === 'graph') renderKBGraph();
      }, 200);
    });
  }
  // 分类筛选
  const catFilter = document.getElementById('kb-cat-filter');
  if (catFilter) {
    catFilter.addEventListener('change', (e) => {
      state.currentKbCategoryId = e.target.value === 'all' ? null : e.target.value;
      renderKBItems();
    });
  }
  // 新建分类
  const btnNewCat = document.getElementById('btn-kb-new-category');
  if (btnNewCat) {
    btnNewCat.addEventListener('click', () => openKBCategoryDrawer(null));
  }
  // 新建条目
  const btnNewItem = document.getElementById('btn-kb-new-item');
  if (btnNewItem) {
    btnNewItem.addEventListener('click', () => openKBDrawer(null));
  }
  // 加载演示数据
  document.getElementById('btn-kb-seed-demo')?.addEventListener('click', seedKBDemo);
  document.getElementById('btn-kb-seed-demo-2')?.addEventListener('click', seedKBDemo);
  // 抽屉
  const drawer = document.getElementById('kb-drawer');
  if (drawer) {
    document.getElementById('kb-drawer-cancel')?.addEventListener('click', () => closeDrawer('kb-drawer'));
    document.getElementById('kb-drawer-save')?.addEventListener('click', saveKBItemFromDrawer);
    document.getElementById('kb-drawer-delete')?.addEventListener('click', deleteKBItemFromDrawer);
    drawer.querySelectorAll('[data-close="kb-drawer"]').forEach(b => b.addEventListener('click', () => closeDrawer('kb-drawer')));
  }
  // 图谱：创建关联
  document.getElementById('kb-link-create')?.addEventListener('click', createKBLink);
}

async function loadKB() {
  try {
    const { data } = await api('/api/kb');
    state.kbCategories = data.categories || [];
    state.kbItems = data.items || [];
    state.kbLinks = data.links || [];
    // 默认全部展开
    for (const c of state.kbCategories) {
      if (kbState.expanded[c.id] === undefined) kbState.expanded[c.id] = true;
    }
    updateKBStats();
    renderKB();
    if (state.kbView === 'graph') renderKBGraph();
    updateTabCounts();
  } catch (e) {
    console.error('loadKB:', e);
  }
}

function updateKBStats() {
  const el = document.getElementById('kb-stats');
  if (el) el.textContent = `${state.kbCategories.length} 分类 / ${state.kbItems.length} 条目`;
}

function filterKBItems() {
  const q = (kbState.searchKeyword || '').toLowerCase();
  let items = state.kbItems;
  // 按分类筛选
  if (state.currentKbCategoryId) {
    items = items.filter(i => i.category_id === state.currentKbCategoryId);
  }
  // 按关键词筛选
  if (q) {
    items = items.filter(i =>
      (i.title || '').toLowerCase().includes(q) ||
      (i.body || '').toLowerCase().includes(q) ||
      (i.tags || []).some(t => (t || '').toLowerCase().includes(q))
    );
  }
  return items;
}

function renderKB() {
  renderKBCategories();
  renderKBCatFilter();
  renderKBItems();
}

function renderKBCategories() {
  const side = document.getElementById('kb-side');
  if (!side) return;
  if (!state.kbCategories.length) {
    side.innerHTML = `
      <div class="empty-state" style="padding: 20px 10px;">
        <div class="empty-icon">📂</div>
        <div class="empty-text">暂无分类</div>
        <div class="empty-hint">点击"+ 新建分类"</div>
      </div>`;
    return;
  }

  const allCount = state.kbItems.length;
  const allItem = { id: null, name: '全部', icon: '🌐' };

  let html = `
    <div class="kb-cat-item ${!state.currentKbCategoryId ? 'active' : ''}" data-cat-id="">
      <span class="kb-cat-icon">${allItem.icon}</span>
      <span class="kb-cat-name">${allItem.name}</span>
      <span class="kb-cat-count">${allCount}</span>
    </div>`;

  for (const c of state.kbCategories) {
    const count = state.kbItems.filter(i => i.category_id === c.id).length;
    html += `
      <div class="kb-cat-item ${state.currentKbCategoryId === c.id ? 'active' : ''}" data-cat-id="${c.id}">
        <span class="kb-cat-icon">${escapeHtml(c.icon || '📁')}</span>
        <span class="kb-cat-name">${escapeHtml(c.name)}</span>
        <span class="kb-cat-count">${count}</span>
      </div>`;
  }
  side.innerHTML = html;

  side.querySelectorAll('.kb-cat-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.catId || null;
      state.currentKbCategoryId = id;
      // 同步顶部筛选下拉
      const filter = document.getElementById('kb-cat-filter');
      if (filter) filter.value = id || 'all';
      renderKB();
    });
  });
}

function renderKBCatFilter() {
  const sel = document.getElementById('kb-cat-filter');
  if (!sel) return;
  const cur = state.currentKbCategoryId || 'all';
  sel.innerHTML = `<option value="all">全部分类</option>` +
    state.kbCategories.map(c =>
      `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${escapeHtml(c.icon || '📁')} ${escapeHtml(c.name)}</option>`
    ).join('');
}

function renderKBItems() {
  const list = document.getElementById('kb-items-list');
  const title = document.getElementById('kb-items-title');
  const count = document.getElementById('kb-items-count');
  if (!list) return;

  const items = filterKBItems();
  if (title) {
    if (!state.currentKbCategoryId) {
      title.textContent = '全部条目';
    } else {
      const cat = state.kbCategories.find(c => c.id === state.currentKbCategoryId);
      title.textContent = cat ? `${cat.icon || '📁'} ${cat.name}` : '未分类';
    }
  }
  if (count) count.textContent = `${items.length} 条`;

  if (!items.length) {
    list.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-icon">📭</div>
        <div class="empty-text">${kbState.searchKeyword ? '没有匹配的条目' : '该分类暂无条目'}</div>
        <div class="empty-hint">${kbState.searchKeyword ? '换个关键词试试' : '点击"+ 新建条目"'}</div>
      </div>`;
    return;
  }

  list.innerHTML = items.map(i => {
    const preview = (i.body || '').slice(0, 80).replace(/\n/g, ' ');
    const tags = (i.tags || []).slice(0, 3).map(t => `<span class="kb-tag">${escapeHtml(t)}</span>`).join('');
    return `
      <div class="kb-item-card" data-item-id="${i.id}">
        <div class="kb-item-card-header">
          <div class="kb-item-card-title">${escapeHtml(i.title)}</div>
          <div class="kb-item-card-actions">
            <button data-action="edit" data-id="${i.id}" title="编辑">✏️</button>
            <button data-action="delete" data-id="${i.id}" title="删除">🗑</button>
          </div>
        </div>
        <div class="kb-item-card-preview">${escapeHtml(preview)}</div>
        <div class="kb-item-card-footer">
          <div class="kb-item-card-tags">${tags}</div>
          <div class="kb-item-card-time">${formatRelative(i.updated_at)}</div>
        </div>
      </div>`;
  }).join('');

  // 事件：点击卡片 = 编辑，点条目主体 = 填入聊天输入框
  list.querySelectorAll('.kb-item-card').forEach(card => {
    const id = card.dataset.itemId;
    card.querySelector('.kb-item-card-title')?.addEventListener('click', () => fillChatWithKBItem(id));
    card.querySelector('.kb-item-card-preview')?.addEventListener('click', () => fillChatWithKBItem(id));
    card.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openKBDrawer(id);
    });
    card.querySelector('[data-action="delete"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('确认删除该条目？')) {
        await api(`/api/kb/items/${id}`, { method: 'DELETE' });
        showNotification('✓ 已删除', 'success');
        await loadKB();
      }
    });
  });
}

// === 抽屉：条目详情/编辑 ===
function openKBDrawer(itemId) {
  const drawer = document.getElementById('kb-drawer');
  if (!drawer) return;
  const titleInput = document.getElementById('kb-drawer-title-input');
  const bodyInput = document.getElementById('kb-drawer-body-input');
  const tagsInput = document.getElementById('kb-drawer-tags-input');
  const catSelect = document.getElementById('kb-drawer-cat-select');
  const meta = document.getElementById('kb-drawer-meta');
  const titleEl = document.getElementById('kb-drawer-title');
  const delBtn = document.getElementById('kb-drawer-delete');

  // 填充分类选项
  catSelect.innerHTML = state.kbCategories.map(c =>
    `<option value="${c.id}">${escapeHtml(c.icon || '📁')} ${escapeHtml(c.name)}</option>`
  ).join('');

  if (itemId) {
    const item = state.kbItems.find(i => i.id === itemId);
    if (!item) return;
    titleEl.textContent = '✏️ 编辑条目';
    titleInput.value = item.title || '';
    bodyInput.value = item.body || '';
    tagsInput.value = (item.tags || []).join(', ');
    catSelect.value = item.category_id || '';
    meta.textContent = `ID: ${item.id} · 创建 ${formatRelative(item.created_at)} · 更新 ${formatRelative(item.updated_at)}`;
    drawer.dataset.itemId = itemId;
    if (delBtn) delBtn.style.display = '';
  } else {
    titleEl.textContent = '📖 新建条目';
    titleInput.value = '';
    bodyInput.value = '';
    tagsInput.value = '';
    catSelect.value = state.currentKbCategoryId || (state.kbCategories[0]?.id || '');
    meta.textContent = '新建后保存';
    delete drawer.dataset.itemId;
    if (delBtn) delBtn.style.display = 'none';
  }
  openDrawer('kb-drawer');
  setTimeout(() => titleInput?.focus(), 100);
}

async function saveKBItemFromDrawer() {
  const drawer = document.getElementById('kb-drawer');
  const title = document.getElementById('kb-drawer-title-input').value.trim();
  const body = document.getElementById('kb-drawer-body-input').value.trim();
  const tagsRaw = document.getElementById('kb-drawer-tags-input').value.trim();
  const category_id = document.getElementById('kb-drawer-cat-select').value;

  if (!title) return showNotification('❌ 标题必填', 'error');
  if (!body) return showNotification('❌ 正文必填', 'error');
  if (!category_id) return showNotification('❌ 请选择分类', 'error');

  const tags = tagsRaw ? tagsRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 8) : [];

  try {
    if (drawer.dataset.itemId) {
      await api(`/api/kb/items/${drawer.dataset.itemId}`, {
        method: 'PATCH',
        body: { title, body, category_id, tags }
      });
      showNotification('✓ 已更新', 'success');
    } else {
      await api('/api/kb/items', {
        method: 'POST',
        body: { title, body, category_id, tags }
      });
      showNotification('✓ 已创建', 'success');
    }
    closeDrawer('kb-drawer');
    await loadKB();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

async function deleteKBItemFromDrawer() {
  const drawer = document.getElementById('kb-drawer');
  const id = drawer.dataset.itemId;
  if (!id) return;
  if (!confirm('确认删除该条目？')) return;
  try {
    await api(`/api/kb/items/${id}`, { method: 'DELETE' });
    showNotification('✓ 已删除', 'success');
    closeDrawer('kb-drawer');
    await loadKB();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

function openKBCategoryDrawer(cat) {
  const name = cat ? prompt('修改分类名：', cat.name) : prompt('新分类名称：');
  if (name === null || !name?.trim()) return;
  const icon = (cat ? prompt('修改图标：', cat.icon) : prompt('分类图标（emoji，留空用 📁）：')) || '📁';
  if (cat) {
    api(`/api/kb/categories/${cat.id}`, { method: 'PATCH', body: { name, icon } })
      .then(() => { showNotification('✓ 已更新', 'success'); loadKB(); })
      .catch(e => showNotification(`❌ ${e.message}`, 'error'));
  } else {
    api('/api/kb/categories', { method: 'POST', body: { name, icon } })
      .then(() => { showNotification('✓ 分类已创建', 'success'); loadKB(); })
      .catch(e => showNotification(`❌ ${e.message}`, 'error'));
  }
}

function fillChatWithKBItem(itemOrId) {
  const item = typeof itemOrId === 'string'
    ? state.kbItems.find(i => i.id === itemOrId)
    : itemOrId;
  if (!item) return;
  const input = document.getElementById('compose-input');
  if (input) {
    input.value = item.body || item.title || '';
    input.disabled = false;
    autoResizeInput({ target: input });
    switchTab('chat');
    showNotification(`📖 已填入条目: ${item.title}`, 'info');
  }
}

// ======== v4.3.0 知识图谱（KB Graph View） ========

// 分类 → 颜色映射（每个分类一种主色，节点用此着色）
const KB_CATEGORY_COLORS = [
  '#667eea', // primary blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16'  // lime
];

function getCategoryColor(catId) {
  const idx = state.kbCategories.findIndex(c => c.id === catId);
  return KB_CATEGORY_COLORS[(idx >= 0 ? idx : 0) % KB_CATEGORY_COLORS.length];
}

function getCategoryById(catId) {
  return state.kbCategories.find(c => c.id === catId);
}

function switchKBView(view) {
  state.kbView = view;
  document.querySelectorAll('#kb-view-tabs .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === view);
  });
  const listView = document.getElementById('kb-view-list');
  const graphView = document.getElementById('kb-view-graph');
  if (view === 'list') {
    listView.hidden = false;
    graphView.hidden = true;
  } else {
    listView.hidden = true;
    graphView.hidden = false;
    // 等浏览器 reflow（hidden 切走后容器才有真实尺寸），再初始化 Cytoscape
    requestAnimationFrame(() => renderKBGraph());
  }
}

function buildCyElements() {
  // 节点：所有条目（按分类着色，样式由 cy.style() 控制，不在这里写内联 style）
  const nodes = state.kbItems.map(item => {
    const cat = getCategoryById(item.category_id);
    return {
      group: 'nodes',
      data: {
        id: item.id,
        label: item.title.slice(0, 14),
        fullTitle: item.title,
        catId: item.category_id || '__orphan__',
        catColor: getCategoryColor(item.category_id),
        catName: cat?.name || '未分类',
        catIcon: cat?.icon || '📁'
      }
    };
  });

  // 边：所有关联（样式由 cy.style() 控制）
  const edges = state.kbLinks.map(link => ({
    group: 'edges',
    data: {
      id: link.id,
      source: link.source_id,
      target: link.target_id,
      label: link.label || '',
      type: link.type
    }
  }));

  return [...nodes, ...edges];
}

function renderKBGraph() {
  const container = document.getElementById('cy');
  if (!container) return;
  if (typeof cytoscape === 'undefined') {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8">⚠️ Cytoscape.js 未加载（CDN 失败？）</div>';
    return;
  }

  // 重建下拉
  renderKBLinkForm();

  // 重建关联列表
  renderKBLinkList();

  // 重建 cytoscape
  if (state.cy) {
    state.cy.destroy();
    state.cy = null;
  }
  state.cy = cytoscape({
    container,
    elements: buildCyElements(),
    layout: {
      name: 'cose',
      animate: false,
      padding: 30,
      nodeRepulsion: () => 8000,
      idealEdgeLength: () => 120,
      gravity: 0.4,
      numIter: 1500
    },
    style: [
      {
        selector: 'node',
        style: {
          'shape': 'round-rectangle',
          'background-color': 'data(catColor)',
          'border-color': '#1e293b',
          'border-width': 2,
          'label': 'data(label)',
          'color': '#fff',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '160px',
          'width': 'label',
          'height': 'label',
          'padding': '14px',
          'font-size': '12px',
          'font-weight': 600
        }
      },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'width': 2,
          'line-color': '#64748b',
          'target-arrow-color': '#64748b',
          'target-arrow-shape': 'triangle',
          'label': 'data(label)',
          'font-size': '10px',
          'color': '#475569',
          'text-background-color': '#fff',
          'text-background-opacity': 0.85,
          'text-background-padding': '2px',
          'text-rotation': 'autorotate'
        }
      },
      // 边按类型着色
      { selector: 'edge[type = "related"]',    style: { 'line-color': '#64748b', 'target-arrow-color': '#64748b' } },
      { selector: 'edge[type = "depends_on"]', style: { 'line-color': '#ef4444', 'target-arrow-color': '#ef4444', 'line-style': 'dashed' } },
      { selector: 'edge[type = "references"]', style: { 'line-color': '#3b82f6', 'target-arrow-color': '#3b82f6' } },
      { selector: 'edge[type = "contains"]',   style: { 'line-color': '#8b5cf6', 'target-arrow-color': '#8b5cf6' } },
      { selector: 'node:selected', style: { 'border-width': 4, 'border-color': '#0f172a' } },
      { selector: 'edge:selected', style: { 'width': 3.5 } },
      { selector: 'node.orphan',   style: { 'opacity': 0.4 } }
    ],
    minZoom: 0.3,
    maxZoom: 2.5,
    wheelSensitivity: 0.2
  });

  // 节点点击 → 打开条目抽屉
  state.cy.on('tap', 'node', (evt) => {
    const id = evt.target.id();
    openKBDrawer(id);
  });

  // 边点击 → 确认删除
  state.cy.on('tap', 'edge', (evt) => {
    const id = evt.target.id();
    const link = state.kbLinks.find(l => l.id === id);
    if (!link) return;
    if (confirm(`删除关联？\n${link.label ? '【' + link.label + '】\n' : ''}${link.type}`)) {
      deleteKBLink(id);
    }
  });

  // 双击空白处 → 重置布局
  state.cy.on('dblclick', (evt) => {
    if (evt.target === state.cy) state.cy.layout({ name: 'cose', animate: true, padding: 30 }).run();
  });
}

function renderKBLinkForm() {
  const srcSel = document.getElementById('kb-link-source');
  const tgtSel = document.getElementById('kb-link-target');
  if (!srcSel || !tgtSel) return;
  const opts = '<option value="">-- 请选择条目 --</option>' + state.kbItems.map(i => {
    const cat = getCategoryById(i.category_id);
    const label = `${cat?.icon || '📁'} ${i.title.slice(0, 24)}`;
    return `<option value="${i.id}">${escapeHtml(label)}</option>`;
  }).join('');
  srcSel.innerHTML = opts;
  tgtSel.innerHTML = opts;
}

function renderKBLinkList() {
  const list = document.getElementById('kb-link-list');
  const count = document.getElementById('kb-link-count');
  if (!list) return;
  if (count) count.textContent = `${state.kbLinks.length} 条`;
  if (!state.kbLinks.length) {
    list.innerHTML = `<div class="empty-state" style="padding:14px;font-size:11px;color:#94a3b8">暂无关联</div>`;
    return;
  }
  list.innerHTML = state.kbLinks.map(l => {
    const s = state.kbItems.find(i => i.id === l.source_id);
    const t = state.kbItems.find(i => i.id === l.target_id);
    return `
      <div class="kb-link-item" data-link-id="${l.id}">
        <span class="kb-link-type kb-link-type-${escapeHtml(l.type)}">${escapeHtml(l.type)}</span>
        <div class="kb-link-endpoints" title="${escapeHtml(s?.title || '')} → ${escapeHtml(t?.title || '')}">
          <span>${escapeHtml(s?.title || '?')}</span>
          <span class="arrow">→</span>
          <span>${escapeHtml(t?.title || '?')}</span>
        </div>
        <button class="kb-link-del" data-del-link="${l.id}" title="删除">×</button>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-del-link]').forEach(btn => {
    btn.addEventListener('click', () => deleteKBLink(btn.dataset.delLink));
  });
}

async function createKBLink() {
  const sourceId = document.getElementById('kb-link-source')?.value;
  const targetId = document.getElementById('kb-link-target')?.value;
  const type = document.getElementById('kb-link-type')?.value || 'related';
  const label = document.getElementById('kb-link-label')?.value?.trim();

  if (!sourceId || !targetId) {
    showNotification('❌ 请选择源和目标条目', 'error');
    return;
  }
  if (sourceId === targetId) {
    showNotification('❌ 不能关联到自己', 'error');
    return;
  }

  try {
    await api('/api/kb/links', { method: 'POST', body: { source_id: sourceId, target_id: targetId, type, label } });
    showNotification('✓ 关联已创建', 'success');
    document.getElementById('kb-link-label').value = '';
    await loadKB();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

async function deleteKBLink(linkId) {
  try {
    await api(`/api/kb/links/${linkId}`, { method: 'DELETE' });
    showNotification('✓ 关联已删除', 'success');
    await loadKB();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

// 加载演示 KB 数据（分类 + 条目 + 关联）
async function seedKBDemo() {
  if (!confirm('将追加 6 个分类 / 25+ 条目 / 20+ 跨分类关联。\n已存在的数据会自动跳过。\n继续？')) return;
  const btn = document.getElementById('btn-kb-seed-demo');
  const btn2 = document.getElementById('btn-kb-seed-demo-2');
  const old1 = btn?.innerHTML, old2 = btn2?.innerHTML;
  try {
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 加载中…'; }
    if (btn2) { btn2.disabled = true; btn2.innerHTML = '⏳ 加载中…'; }
    const { data, message } = await api('/api/kb/seed-demo', { method: 'POST' });
    showNotification(`✓ ${message}`, 'success', 4000);
    await loadKB();
    // 切到图谱视图，让用户立刻看到丰富的关联
    setTimeout(() => switchKBView('graph'), 200);
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = old1 || '🎁 演示数据'; }
    if (btn2) { btn2.disabled = false; btn2.innerHTML = old2 || '🎁 一键加载演示数据'; }
  }
}

// ======== v4.2.1 工作流面板 ========
async function initWF() {
  bindWFEvents();
  await loadWorkflows();
}

function bindWFEvents() {
  // 搜索
  const search = document.getElementById('wf-search');
  if (search) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderWFList(), 200);
    });
  }
  // 新建工作流
  document.getElementById('btn-wf-new')?.addEventListener('click', () => openWFEditor(null));
  // 加载演示数据
  document.getElementById('btn-wf-seed-demo')?.addEventListener('click', seedWFDemo);
  document.getElementById('btn-wf-seed-demo-2')?.addEventListener('click', seedWFDemo);
  // 抽屉
  const drawer = document.getElementById('wf-drawer');
  if (drawer) {
    document.getElementById('wf-drawer-cancel')?.addEventListener('click', () => closeDrawer('wf-drawer'));
    document.getElementById('wf-drawer-save')?.addEventListener('click', saveWFFromDrawer);
    document.getElementById('wf-drawer-delete')?.addEventListener('click', deleteWFFromDrawer);
    document.getElementById('wf-add-step')?.addEventListener('click', () => addWFStepUI());
    drawer.querySelectorAll('[data-close="wf-drawer"]').forEach(b => b.addEventListener('click', () => closeDrawer('wf-drawer')));
  }
}

async function loadWorkflows() {
  try {
    const { data } = await api('/api/wf');
    state.workflows = data || [];
    renderWFList();
    updateTabCounts();
  } catch (e) {
    console.error('loadWorkflows:', e);
  }
}

// 加载演示工作流
async function seedWFDemo() {
  if (!confirm('将追加 9 个示例工作流（股票分析、天气推送、销售月报、财务对账、客情回访、告警响应、代码重构、周报、客服回复）。\n已存在的工作流会自动跳过。\n继续？')) return;
  const btn = document.getElementById('btn-wf-seed-demo');
  const btn2 = document.getElementById('btn-wf-seed-demo-2');
  const old1 = btn?.innerHTML, old2 = btn2?.innerHTML;
  try {
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 加载中…'; }
    if (btn2) { btn2.disabled = true; btn2.innerHTML = '⏳ 加载中…'; }
    const { data, message } = await api('/api/wf/seed-demo', { method: 'POST' });
    showNotification(`✓ ${message}`, 'success', 4000);
    await loadWorkflows();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = old1 || '🎁 演示数据'; }
    if (btn2) { btn2.disabled = false; btn2.innerHTML = old2 || '🎁 一键加载演示数据'; }
  }
}

function renderWFList() {
  const side = document.getElementById('wf-side');
  const main = document.getElementById('wf-main');
  if (!side) return;

  const q = (document.getElementById('wf-search')?.value || '').toLowerCase();
  const list = state.workflows.filter(w =>
    !q || w.name.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q)
  );

  if (!list.length) {
    side.innerHTML = `
      <div class="empty-state" style="padding: 20px 10px;">
        <div class="empty-icon">⚙️</div>
        <div class="empty-text">暂无工作流</div>
        <div class="empty-hint">点击"+ 新建工作流"</div>
      </div>`;
    if (main && !state.currentWorkflowId) {
      main.innerHTML = `
        <div class="wf-empty">
          <div class="empty-icon">⚙️</div>
          <div class="empty-text">${q ? '没有匹配的工作流' : '选择工作流查看详情'}</div>
          <div class="empty-hint">${q ? '换个关键词试试' : '在左侧选择预定义模板'}</div>
        </div>`;
    }
    return;
  }

  side.innerHTML = list.map(w => `
    <div class="wf-item ${state.currentWorkflowId === w.id ? 'active' : ''}" data-wf-id="${w.id}">
      <span class="wf-item-icon">${escapeHtml(w.icon || '⚙️')}</span>
      <div class="wf-item-info">
        <div class="wf-item-name">${escapeHtml(w.name)}</div>
        <div class="wf-item-meta">${(w.steps || []).length} 步</div>
      </div>
    </div>
  `).join('');

  side.querySelectorAll('.wf-item').forEach(el => {
    el.addEventListener('click', () => selectWorkflow(el.dataset.wfId));
  });

  // 重新选中已选工作流，或默认第一个
  if (state.currentWorkflowId && state.workflows.find(w => w.id === state.currentWorkflowId)) {
    renderWFDetail(state.currentWorkflowId);
  } else if (list.length > 0) {
    selectWorkflow(list[0].id);
  }
}

function selectWorkflow(id) {
  state.currentWorkflowId = id;
  document.querySelectorAll('.wf-item').forEach(el => {
    el.classList.toggle('active', el.dataset.wfId === id);
  });
  renderWFDetail(id);
}

function renderWFDetail(id) {
  const main = document.getElementById('wf-main');
  if (!main) return;
  const wf = state.workflows.find(w => w.id === id);
  if (!wf) {
    main.innerHTML = `<div class="wf-empty"><div class="empty-icon">⚙️</div><div class="empty-text">未找到工作流</div></div>`;
    return;
  }

  const stepsHtml = (wf.steps || []).map((s, i) => {
    const deps = (s.depends_on || []).length
      ? `<span class="wf-step-deps">← 依赖 ${s.depends_on.length} 步</span>`
      : '';
    return `
      <div class="wf-step-card" data-step-id="${s.id}">
        <div class="wf-step-num">${i + 1}</div>
        <div class="wf-step-body">
          <div class="wf-step-name">${escapeHtml(s.name)} ${deps}</div>
          <div class="wf-step-content">${escapeHtml(s.content)}</div>
          <div class="wf-step-meta">
            ${s.task_type ? `<span class="badge">${i18n('type', s.task_type)}</span>` : ''}
            ${s.priority ? `<span class="badge badge-priority-${s.priority}">${i18n('priority', s.priority)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div class="wf-detail">
      <div class="wf-detail-header">
        <div class="wf-detail-title">
          <span class="wf-detail-icon">${escapeHtml(wf.icon || '⚙️')}</span>
          <h2>${escapeHtml(wf.name)}</h2>
        </div>
        <div class="wf-detail-actions">
          <button class="btn-secondary" id="wf-btn-edit">✏️ 编辑</button>
          <button class="btn-primary" id="wf-btn-execute">▶ 执行</button>
        </div>
      </div>
      ${wf.description ? `<p class="wf-detail-desc">${escapeHtml(wf.description)}</p>` : ''}
      <div class="wf-detail-meta">
        <span>共 ${(wf.steps || []).length} 步</span>
        <span>·</span>
        <span>创建 ${formatRelative(wf.created_at)}</span>
        <span>·</span>
        <span>更新 ${formatRelative(wf.updated_at)}</span>
      </div>
      <div class="wf-steps-list">${stepsHtml}</div>
    </div>`;

  document.getElementById('wf-btn-edit')?.addEventListener('click', () => openWFEditor(id));
  document.getElementById('wf-btn-execute')?.addEventListener('click', () => executeWF(id));
}

async function executeWF(id) {
  const sessionId = state.currentSessionId;
  if (!sessionId) {
    showNotification('❌ 请先在聊天面板选择/创建一个会话', 'error');
    return;
  }
  if (!confirm('执行此工作流将创建一批任务，确定继续？')) return;
  try {
    const { data } = await api(`/api/wf/${id}/execute`, {
      method: 'POST',
      body: { session_id: sessionId }
    });
    showNotification(`✓ 已创建 ${data.task_ids.length} 个任务`, 'success');
    switchTab('chat');
    await loadTasks();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

function openWFEditor(id) {
  const drawer = document.getElementById('wf-drawer');
  if (!drawer) return;
  const wf = id ? state.workflows.find(w => w.id === id) : null;
  document.getElementById('wf-drawer-title').textContent = wf ? '✏️ 编辑工作流' : '⚙️ 新建工作流';
  document.getElementById('wf-drawer-name-input').value = wf?.name || '';
  document.getElementById('wf-drawer-icon-input').value = wf?.icon || '⚙️';
  document.getElementById('wf-drawer-desc-input').value = wf?.description || '';

  const stepsList = document.getElementById('wf-steps-list');
  if (stepsList) {
    stepsList.innerHTML = '';
    const steps = wf?.steps || [{ id: `step-${Date.now()}`, name: '步骤 1', content: '', task_type: 'chat', priority: 'normal' }];
    steps.forEach(s => addWFStepUI(s));
  }

  drawer.dataset.wfId = id || '';
  const delBtn = document.getElementById('wf-drawer-delete');
  if (delBtn) delBtn.style.display = wf ? '' : 'none';
  openDrawer('wf-drawer');
}

function addWFStepUI(step) {
  const container = document.getElementById('wf-steps-list');
  if (!container) return;
  const id = step?.id || `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const el = document.createElement('div');
  el.className = 'wf-step-edit';
  el.dataset.stepId = id;
  el.innerHTML = `
    <div class="wf-step-edit-row">
      <input type="text" class="wf-step-name-input" placeholder="步骤名" value="${escapeHtml(step?.name || '')}" maxlength="64">
      <button class="btn-icon wf-step-remove" title="删除">×</button>
    </div>
    <textarea class="wf-step-content-input" placeholder="任务内容" rows="2" maxlength="2000">${escapeHtml(step?.content || '')}</textarea>
    <div class="wf-step-edit-row">
      <select class="wf-step-type-input">
        <option value="chat" ${step?.task_type === 'chat' ? 'selected' : ''}>💬 聊天</option>
        <option value="query_info" ${step?.task_type === 'query_info' ? 'selected' : ''}>🔍 查询</option>
        <option value="multi_step" ${step?.task_type === 'multi_step' ? 'selected' : ''}>🔄 多步</option>
      </select>
      <select class="wf-step-priority-input">
        <option value="low" ${step?.priority === 'low' ? 'selected' : ''}>低</option>
        <option value="normal" ${step?.priority === 'normal' || !step?.priority ? 'selected' : ''}>普通</option>
        <option value="high" ${step?.priority === 'high' ? 'selected' : ''}>高</option>
        <option value="urgent" ${step?.priority === 'urgent' ? 'selected' : ''}>紧急</option>
      </select>
    </div>
  `;
  el.querySelector('.wf-step-remove')?.addEventListener('click', () => el.remove());
  container.appendChild(el);
}

async function saveWFFromDrawer() {
  const drawer = document.getElementById('wf-drawer');
  const id = drawer.dataset.wfId;
  const name = document.getElementById('wf-drawer-name-input').value.trim();
  const icon = document.getElementById('wf-drawer-icon-input').value.trim() || '⚙️';
  const description = document.getElementById('wf-drawer-desc-input').value.trim();

  if (!name) return showNotification('❌ 工作流名称必填', 'error');

  const stepEls = document.querySelectorAll('#wf-steps-list .wf-step-edit');
  if (!stepEls.length) return showNotification('❌ 至少 1 个步骤', 'error');

  const steps = Array.from(stepEls).map((el, i) => ({
    id: el.dataset.stepId || `step-${i}-${Date.now()}`,
    name: el.querySelector('.wf-step-name-input').value.trim() || `步骤 ${i + 1}`,
    content: el.querySelector('.wf-step-content-input').value.trim(),
    task_type: el.querySelector('.wf-step-type-input').value,
    priority: el.querySelector('.wf-step-priority-input').value
  })).filter(s => s.content);

  if (!steps.length) return showNotification('❌ 至少 1 个步骤有内容', 'error');

  try {
    if (id) {
      await api(`/api/wf/${id}`, { method: 'PATCH', body: { name, icon, description, steps } });
      showNotification('✓ 已更新', 'success');
    } else {
      await api('/api/wf', { method: 'POST', body: { name, icon, description, steps } });
      showNotification('✓ 已创建', 'success');
    }
    closeDrawer('wf-drawer');
    await loadWorkflows();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

async function deleteWFFromDrawer() {
  const drawer = document.getElementById('wf-drawer');
  const id = drawer.dataset.wfId;
  if (!id) return;
  if (!confirm('确认删除此工作流？')) return;
  try {
    await api(`/api/wf/${id}`, { method: 'DELETE' });
    showNotification('✓ 已删除', 'success');
    closeDrawer('wf-drawer');
    state.currentWorkflowId = null;
    await loadWorkflows();
  } catch (e) {
    showNotification(`❌ ${e.message}`, 'error');
  }
}

// ======== v5.1.0 计划模块 ========
// 数据存储：localStorage（轻量级、无后端依赖、可导出/导入）
const PLAN_STORAGE_KEY = 'ai_bridge_plans_v1';
const PLAN_PRIORITY_LABEL = { low: '低', normal: '普通', high: '高' };
const PLAN_STATUS_LABEL = {
  pending: '⏳ 待开始',
  in_progress: '⚙️ 进行中',
  done: '✅ 已完成',
  cancelled: '❌ 已取消'
};
const PLAN_TYPE_LABEL = { day: '日计划', week: '周计划' };

function loadPlansFromStorage() {
  try {
    const raw = localStorage.getItem(PLAN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePlansToStorage(plans) {
  try {
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans));
  } catch (e) {
    console.error('[plan] localStorage 保存失败:', e);
  }
}

function generatePlanId() {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 工具：获取日期所在 ISO 周（周一为周首日）的起止
 *  返回 { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', label: 'W## 2026-07-20~07-26' }
 */
function getISOWeekRange(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // 周一首日：getDay() 周日为 0，周一为 1
  const day = d.getDay() || 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const iso = (d1) => d1.toISOString().slice(0, 10);
  const weekNum = getISOWeekNumber(d);
  return {
    start: iso(monday),
    end: iso(sunday),
    label: `W${String(weekNum).padStart(2, '0')} ${monday.getMonth() + 1}/${monday.getDate()}-${sunday.getMonth() + 1}/${sunday.getDate()}`
  };
}

function getISOWeekNumber(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  // ISO 周四所在年
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

function getNextWeekRange() {
  const cur = getISOWeekRange();
  const start = new Date(cur.start);
  start.setDate(start.getDate() + 7);
  const end = new Date(cur.end);
  end.setDate(end.getDate() + 7);
  const iso = (d1) => d1.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

function inDateRange(dateStr, startStr, endStr) {
  return dateStr >= startStr && dateStr <= endStr;
}

function isCurrentWeek(dateStr) {
  const { start, end } = getISOWeekRange();
  return inDateRange(dateStr, start, end);
}

function isNextWeek(dateStr) {
  const { start, end } = getNextWeekRange();
  return inDateRange(dateStr, start, end);
}

/**
 * 初始化计划模块
 */
function initPlan() {
  state.plans = loadPlansFromStorage();

  // 工具栏事件
  const searchInput = document.getElementById('plan-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.planFilter.search = e.target.value;
      renderPlans();
    });
  }
  const typeFilter = document.getElementById('plan-type-filter');
  if (typeFilter) {
    typeFilter.addEventListener('change', (e) => {
      state.planFilter.type = e.target.value;
      renderPlans();
    });
  }
  const statusFilter = document.getElementById('plan-status-filter');
  if (statusFilter) {
    statusFilter.addEventListener('change', (e) => {
      state.planFilter.status = e.target.value;
      renderPlans();
    });
  }
  const weekFilter = document.getElementById('plan-week-filter');
  if (weekFilter) {
    weekFilter.addEventListener('change', (e) => {
      state.planFilter.week = e.target.value;
      renderPlans();
    });
  }

  // 按钮事件
  const btnNew = document.getElementById('btn-plan-new');
  if (btnNew) btnNew.addEventListener('click', () => openPlanDrawer(null));
  const btnSeed = document.getElementById('btn-plan-seed-demo');
  if (btnSeed) btnSeed.addEventListener('click', seedPlanDemo);
  const btnSeed2 = document.getElementById('btn-plan-seed-demo-2');
  if (btnSeed2) btnSeed2.addEventListener('click', seedPlanDemo);

  // 抽屉事件
  const drawerSave = document.getElementById('plan-drawer-save');
  if (drawerSave) drawerSave.addEventListener('click', savePlanFromDrawer);
  const drawerCancel = document.getElementById('plan-drawer-cancel');
  if (drawerCancel) drawerCancel.addEventListener('click', () => closeDrawer('plan-drawer'));
  const drawerDelete = document.getElementById('plan-drawer-delete');
  if (drawerDelete) drawerDelete.addEventListener('click', deletePlanFromDrawer);

  renderPlans();
  updateTabCounts();
}

/**
 * 应用过滤规则，生成显示用列表
 */
function getFilteredPlans() {
  const f = state.planFilter;
  return (state.plans || []).filter((p) => {
    if (f.type !== 'all' && p.type !== f.type) return false;
    if (f.status !== 'all' && p.status !== f.status) return false;
    if (f.week === 'current' && !isCurrentWeek(p.date)) return false;
    if (f.week === 'next' && !isNextWeek(p.date)) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      const hay = `${p.title} ${p.details || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    // 排序：日期升序 → 优先级 high 优先 → 状态 pending 优先
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const pr = { high: 0, normal: 1, low: 2 };
    const da = pr[a.priority] ?? 1;
    const db = pr[b.priority] ?? 1;
    if (da !== db) return da - db;
    return a.created_at - b.created_at;
  });
}

/**
 * 渲染左侧分组列表
 */
function renderPlans() {
  const sideEl = document.getElementById('plan-side');
  const mainEl = document.getElementById('plan-main');
  const emptyEl = document.getElementById('plan-empty');
  if (!sideEl || !mainEl) return;

  const filtered = getFilteredPlans();

  // 无数据 → 显示 empty
  if (!state.plans || state.plans.length === 0) {
    sideEl.innerHTML = '';
    mainEl.innerHTML = '';
    mainEl.appendChild(emptyEl);
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // 分组：按 type 分（周 / 日）
  const groups = { week: [], day: [] };
  for (const p of filtered) {
    if (groups[p.type]) groups[p.type].push(p);
  }

  let sideHtml = '';
  for (const type of ['week', 'day']) {
    if (groups[type].length === 0) continue;
    sideHtml += `
      <div class="plan-group-title">
        <span>${type === 'week' ? '📆 周计划' : '📅 日计划'}</span>
        <span class="count">${groups[type].length}</span>
      </div>`;
    for (const p of groups[type]) {
      const isActive = p.id === state.currentPlanId;
      sideHtml += `
        <div class="plan-item ${isActive ? 'active' : ''}" data-plan-id="${escapeHtml(p.id)}">
          <div class="plan-item-row">
            <span class="plan-item-title">${escapeHtml(p.title)}</span>
            <span class="plan-item-date">${escapeHtml(p.date.slice(5))}</span>
          </div>
          <div class="plan-item-meta">
            <span class="badge status-${escapeHtml(p.status)}">${escapeHtml(PLAN_STATUS_LABEL[p.status] || p.status)}</span>
            <span class="badge priority-${escapeHtml(p.priority)}">${escapeHtml(PLAN_PRIORITY_LABEL[p.priority] || p.priority)}</span>
          </div>
        </div>`;
    }
  }
  if (!sideHtml) {
    sideHtml = `<div class="empty-state" style="padding:24px"><div class="empty-text">没有匹配的计划</div><div class="empty-hint">调整筛选条件试试</div></div>`;
  }
  sideEl.innerHTML = sideHtml;

  // 绑定侧栏点击
  sideEl.querySelectorAll('.plan-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.planId;
      selectPlan(id);
    });
  });

  // 主区域：渲染详情或空状态
  if (state.currentPlanId) {
    const p = state.plans.find((x) => x.id === state.currentPlanId);
    if (p) {
      renderPlanDetail(p);
      return;
    }
  }
  // 无选中 → 显示引导
  mainEl.innerHTML = `
    <div class="plan-empty">
      <div class="empty-icon">👈</div>
      <div class="empty-text">选择计划查看详情</div>
      <div class="empty-hint">左侧列表里点击，或「+ 新建计划」</div>
    </div>`;
}

function selectPlan(id) {
  state.currentPlanId = id;
  renderPlans();
}

function renderPlanDetail(p) {
  const mainEl = document.getElementById('plan-main');
  if (!mainEl) return;
  const createdAt = new Date(p.created_at).toLocaleString('zh-CN');
  const updatedAt = p.updated_at ? new Date(p.updated_at).toLocaleString('zh-CN') : createdAt;
  mainEl.innerHTML = `
    <div class="plan-detail">
      <div class="plan-detail-header">
        <div class="plan-detail-title">${escapeHtml(p.title)}</div>
        <div class="plan-detail-meta">
          <span class="badge">${escapeHtml(PLAN_TYPE_LABEL[p.type] || p.type)}</span>
          <span class="badge">📅 ${escapeHtml(p.date)}</span>
          <span class="badge">${escapeHtml(PLAN_STATUS_LABEL[p.status] || p.status)}</span>
          <span class="badge">优先级: ${escapeHtml(PLAN_PRIORITY_LABEL[p.priority] || p.priority)}</span>
        </div>
      </div>
      <div class="plan-detail-body">${escapeHtml(p.details || '')}</div>
      <div class="plan-detail-actions">
        <button class="btn-secondary" id="plan-detail-edit">✎ 编辑</button>
        <button class="btn-secondary" id="plan-detail-status-toggle">${p.status === 'done' ? '↺ 重新打开' : '✓ 标记完成'}</button>
        <button class="btn-danger" id="plan-detail-delete">🗑 删除</button>
      </div>
      <div style="padding:8px 28px 24px;font-size:11px;color:#9ca3af;">
        创建: ${escapeHtml(createdAt)} · 更新: ${escapeHtml(updatedAt)}
      </div>
    </div>`;

  const editBtn = document.getElementById('plan-detail-edit');
  if (editBtn) editBtn.addEventListener('click', () => openPlanDrawer(p.id));
  const statusBtn = document.getElementById('plan-detail-status-toggle');
  if (statusBtn) {
    statusBtn.addEventListener('click', () => togglePlanStatus(p.id));
  }
  const delBtn = document.getElementById('plan-detail-delete');
  if (delBtn) delBtn.addEventListener('click', () => {
    if (confirm('确认删除此计划？')) {
      state.plans = state.plans.filter((x) => x.id !== p.id);
      savePlansToStorage(state.plans);
      state.currentPlanId = null;
      renderPlans();
      updateTabCounts();
      showNotification('✓ 已删除', 'success');
    }
  });
}

function togglePlanStatus(id) {
  const p = state.plans.find((x) => x.id === id);
  if (!p) return;
  p.status = p.status === 'done' ? 'in_progress' : 'done';
  p.updated_at = Date.now();
  savePlansToStorage(state.plans);
  renderPlans();
  showNotification(p.status === 'done' ? '✓ 已标记完成' : '↺ 已重新打开', 'success');
}

function openPlanDrawer(planId) {
  const drawer = document.getElementById('plan-drawer');
  if (!drawer) return;
  const today = new Date().toISOString().slice(0, 10);
  const p = planId ? state.plans.find((x) => x.id === planId) : null;
  drawer.dataset.planId = p ? p.id : '';

  document.getElementById('plan-drawer-title').textContent = p ? '✎ 编辑计划' : '📅 新建计划';
  document.getElementById('plan-drawer-title-input').value = p ? p.title : '';
  document.getElementById('plan-drawer-type-select').value = p ? p.type : 'day';
  document.getElementById('plan-drawer-date-input').value = p ? p.date : today;
  document.getElementById('plan-drawer-status-select').value = p ? p.status : 'pending';
  document.getElementById('plan-drawer-priority-select').value = p ? p.priority : 'normal';
  document.getElementById('plan-drawer-details-input').value = p ? (p.details || '') : '';
  document.getElementById('plan-drawer-meta').textContent = p
    ? `创建于 ${new Date(p.created_at).toLocaleString('zh-CN')}`
    : '';
  document.getElementById('plan-drawer-delete').style.display = p ? '' : 'none';
  document.getElementById('plan-drawer-title-input').focus();

  openDrawer('plan-drawer');
}

async function savePlanFromDrawer() {
  const drawer = document.getElementById('plan-drawer');
  if (!drawer) return;
  const id = drawer.dataset.planId;
  const title = document.getElementById('plan-drawer-title-input').value.trim();
  const type = document.getElementById('plan-drawer-type-select').value;
  const date = document.getElementById('plan-drawer-date-input').value;
  const status = document.getElementById('plan-drawer-status-select').value;
  const priority = document.getElementById('plan-drawer-priority-select').value;
  const details = document.getElementById('plan-drawer-details-input').value.trim();

  if (!title) return showNotification('❌ 标题不能为空', 'error');
  if (!date) return showNotification('❌ 日期不能为空', 'error');

  if (id) {
    const p = state.plans.find((x) => x.id === id);
    if (p) {
      p.title = title;
      p.type = type;
      p.date = date;
      p.status = status;
      p.priority = priority;
      p.details = details;
      p.updated_at = Date.now();
    }
    showNotification('✓ 已更新', 'success');
  } else {
    state.plans.push({
      id: generatePlanId(),
      title,
      type,
      date,
      status,
      priority,
      details,
      created_at: Date.now(),
      updated_at: Date.now()
    });
    showNotification('✓ 已创建', 'success');
  }

  savePlansToStorage(state.plans);
  closeDrawer('plan-drawer');
  renderPlans();
  updateTabCounts();
}

function deletePlanFromDrawer() {
  const drawer = document.getElementById('plan-drawer');
  if (!drawer) return;
  const id = drawer.dataset.planId;
  if (!id) return;
  if (!confirm('确认删除此计划？')) return;
  state.plans = state.plans.filter((x) => x.id !== id);
  savePlansToStorage(state.plans);
  closeDrawer('plan-drawer');
  state.currentPlanId = null;
  renderPlans();
  updateTabCounts();
  showNotification('✓ 已删除', 'success');
}

/**
 * 一键加载演示数据：基于当前周 + 下周，覆盖 8 条计划
 */
function seedPlanDemo() {
  if (state.plans && state.plans.length > 0) {
    if (!confirm(`已有 ${state.plans.length} 条计划，继续将追加 8 条示例。是否继续？`)) return;
  }

  const cur = getISOWeekRange();
  const nxt = getNextWeekRange();
  const now = Date.now();
  const dayOffset = (weekStart, offset) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  const seedPlans = [
    // ===== 本周（周计划 + 日计划）=====
    {
      id: generatePlanId(), type: 'week', date: cur.start,
      title: `本周重点：完成知识库重构 & 修复 3 个 P1 bug`,
      details: '周计划：\n• 推进知识库 2.0 架构（分类树 + 全文搜索）\n• 修复 3 个 P1 缺陷（工单 #421/#423/#427）\n• 周三 14:00 团队同步\n• 周五 16:00 周报',
      status: 'in_progress', priority: 'high', created_at: now, updated_at: now
    },
    {
      id: generatePlanId(), type: 'day', date: dayOffset(cur.start, 0),
      title: '代码审查：PR #158 (知识库 store 重构)',
      details: '重点看：\n1. JSONL append-only 是否所有路径都走 storage.appendTask\n2. transition() 的状态机是否完整\n3. 错误处理是否统一',
      status: 'done', priority: 'high', created_at: now, updated_at: now
    },
    {
      id: generatePlanId(), type: 'day', date: dayOffset(cur.start, 1),
      title: '修复工单 #421：iLink 投递失败',
      details: '复现路径：连续发送 3 条消息 → 平台合并/丢弃。\n临时方案：per-wxid 串行 worker。\n长期方案：等 iLink 平台解封。',
      status: 'in_progress', priority: 'high', created_at: now, updated_at: now
    },
    {
      id: generatePlanId(), type: 'day', date: dayOffset(cur.start, 2),
      title: '团队周中同步会议',
      details: '议程：\n1. 本周进度回顾\n2. P1 缺陷进展\n3. 下周计划\n4. 资源协调',
      status: 'pending', priority: 'normal', created_at: now, updated_at: now
    },
    {
      id: generatePlanId(), type: 'day', date: dayOffset(cur.start, 3),
      title: '修复工单 #423：cytoscape 内联样式',
      details: '原因：cytoscape 3.x 不支持 elements[] 里写 inline style。\n方案：移到 cy.style() 配置，data(catColor) 动态着色。',
      status: 'pending', priority: 'normal', created_at: now, updated_at: now
    },
    {
      id: generatePlanId(), type: 'day', date: dayOffset(cur.start, 4),
      title: '周报 + 下周计划',
      details: '周报模板：\n1. 本周完成\n2. 进行中\n3. 风险/阻塞\n4. 下周计划',
      status: 'pending', priority: 'normal', created_at: now, updated_at: now
    },
    // ===== 下周（周计划 + 日计划）=====
    {
      id: generatePlanId(), type: 'week', date: nxt.start,
      title: `下周重点：发布 v5.1 + 启动 v6.0 规划`,
      details: '周计划：\n• v5.1 发布（计划模块、KB 图谱改进）\n• 启动 v6.0 规划：多租户、SaaS 化\n• 周二 10:00 产品评审\n• 周四 14:00 架构评审',
      status: 'pending', priority: 'normal', created_at: now, updated_at: now
    },
    {
      id: generatePlanId(), type: 'day', date: dayOffset(nxt.start, 0),
      title: 'v5.1 发布检查清单',
      details: '1. 演示数据完整\n2. 文档更新（README + CHANGELOG）\n3. 单元测试覆盖 > 60%\n4. 性能压测（API p95 < 200ms）\n5. 备份当前数据',
      status: 'pending', priority: 'high', created_at: now, updated_at: now
    }
  ];

  state.plans = (state.plans || []).concat(seedPlans);
  savePlansToStorage(state.plans);
  state.planFilter.week = 'all'; // 显示全部以看到所有 seed
  state.planFilter.type = 'all';
  document.getElementById('plan-week-filter').value = 'all';
  document.getElementById('plan-type-filter').value = 'all';
  renderPlans();
  updateTabCounts();
  showNotification(`✓ 已加载 ${seedPlans.length} 条演示计划`, 'success');
}

// ======== v5.1.1 一键生成周报 ========

/**
 * 获取指定周的日期范围（默认本周）
 * @param {'current'|'last'|'next'} which
 */
function getReportWeekRange(which = 'current') {
  if (which === 'last') {
    const cur = getISOWeekRange();
    const start = new Date(cur.start);
    start.setDate(start.getDate() - 7);
    const end = new Date(cur.end);
    end.setDate(end.getDate() - 7);
    const iso = (d) => d.toISOString().slice(0, 10);
    return { start: iso(start), end: iso(end), label: `上周 ${start.getMonth() + 1}/${start.getDate()}-${end.getMonth() + 1}/${end.getDate()}` };
  }
  if (which === 'next') {
    const nxt = getNextWeekRange();
    return { start: nxt.start, end: nxt.end, label: `下周 ${new Date(nxt.start).getMonth() + 1}/${new Date(nxt.start).getDate()}-${new Date(nxt.end).getMonth() + 1}/${new Date(nxt.end).getDate()}` };
  }
  const cur = getISOWeekRange();
  return { start: cur.start, end: cur.end, label: `本周 ${cur.label.split(' ').slice(1).join(' ')}` };
}

/**
 * 生成周报 Markdown
 */
async function generateWeeklyReport(which) {
  const range = getReportWeekRange(which);
  const sections = {
    summary: document.getElementById('report-sec-summary')?.checked,
    plans: document.getElementById('report-sec-plans')?.checked,
    progress: document.getElementById('report-sec-progress')?.checked,
    tasks: document.getElementById('report-sec-tasks')?.checked,
    kb: document.getElementById('report-sec-kb')?.checked,
    next: document.getElementById('report-sec-next')?.checked,
    tips: document.getElementById('report-sec-tips')?.checked
  };

  const lines = [];
  lines.push(`# 周报 · ${range.label}`);
  lines.push('');
  lines.push(`> 生成时间: ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`> 数据范围: ${range.start} ~ ${range.end}`);
  lines.push('');

  // ===== 1) 计划数据（localStorage）=====
  const allPlans = state.plans || [];
  const inRange = (p) => p.date >= range.start && p.date <= range.end;
  const inWeek = (p) => {
    if (p.type === 'week') return p.date >= range.start && p.date <= range.end;
    return inRange(p);
  };
  const weekPlans = allPlans.filter(inWeek);
  const donePlans = weekPlans.filter(p => p.status === 'done');
  const inProgressPlans = weekPlans.filter(p => p.status === 'in_progress');
  const pendingPlans = weekPlans.filter(p => p.status === 'pending');
  const cancelledPlans = weekPlans.filter(p => p.status === 'cancelled');

  // ===== 2) 任务数据（/api/tasks）=====
  let completedTasks = [];
  let taskStats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
  try {
    const sinceMs = new Date(range.start).getTime();
    const res = await fetch(`/api/tasks?since=${sinceMs}&limit=200`);
    const json = await res.json();
    if (json.success) {
      const all = json.data || [];
      taskStats = json.meta?.queue_stats || taskStats;
      // 完成/失败任务
      completedTasks = all.filter(t => t.status === 'completed' || t.status === 'failed');
    }
  } catch (e) {
    console.warn('[weekly-report] 获取任务失败:', e);
  }

  // ===== 3) 知识库数据 =====
  let kbNew = 0;
  if (sections.kb) {
    try {
      const res = await fetch('/api/kb');
      const json = await res.json();
      if (json.success) {
        const sinceMs = new Date(range.start).getTime();
        const items = json.data?.items || [];
        kbNew = items.filter(it => (it.created_at || 0) >= sinceMs).length;
      }
    } catch (e) { /* 静默失败 */ }
  }

  // ===== 4) 渲染各章节 =====
  if (sections.summary) {
    const completionRate = weekPlans.length > 0
      ? Math.round((donePlans.length / weekPlans.length) * 100)
      : 0;
    lines.push('## 📊 数据总览');
    lines.push('');
    lines.push(`| 指标 | 数值 |`);
    lines.push(`|------|------|`);
    lines.push(`| 计划总数 | ${weekPlans.length} |`);
    lines.push(`| 已完成 | ${donePlans.length} (${completionRate}%) |`);
    lines.push(`| 进行中 | ${inProgressPlans.length} |`);
    lines.push(`| 待开始 | ${pendingPlans.length} |`);
    lines.push(`| 已取消 | ${cancelledPlans.length} |`);
    lines.push(`| 完成任务 | ${taskStats.completed || 0} |`);
    lines.push(`| 失败任务 | ${taskStats.failed || 0} |`);
    if (sections.kb) lines.push(`| 知识库新增 | ${kbNew} |`);
    lines.push('');
  }

  if (sections.plans) {
    lines.push('## ✅ 本周完成');
    lines.push('');
    if (donePlans.length === 0) {
      lines.push('_本周无完成的计划_');
    } else {
      for (const p of donePlans) {
        const pri = PLAN_PRIORITY_LABEL[p.priority] || p.priority;
        lines.push(`- [x] **${p.title}** _(${pri})_`);
      }
    }
    lines.push('');
  }

  if (sections.progress) {
    lines.push('## ⚙️ 进行中');
    lines.push('');
    if (inProgressPlans.length === 0) {
      lines.push('_无进行中的计划_');
    } else {
      for (const p of inProgressPlans) {
        const pri = PLAN_PRIORITY_LABEL[p.priority] || p.priority;
        lines.push(`- [ ] **${p.title}** _(${pri})_`);
      }
    }
    lines.push('');
  }

  if (sections.tasks) {
    lines.push('## 📨 完成任务');
    lines.push('');
    if (completedTasks.length === 0) {
      lines.push('_本周无完成的任务_');
    } else {
      // 按会话分组前 10 条
      const top = completedTasks.slice(0, 10);
      for (const t of top) {
        const content = (t.data?.content || '').slice(0, 60).replace(/\n/g, ' ');
        const summary = t.result?.result?.summary || '';
        const ok = t.status === 'completed' ? '✅' : '❌';
        lines.push(`- ${ok} ${content}${summary ? ` → ${summary.slice(0, 50)}` : ''}`);
      }
      if (completedTasks.length > 10) {
        lines.push(`- _...及其他 ${completedTasks.length - 10} 条_`);
      }
    }
    lines.push('');
  }

  if (sections.next) {
    // 下周计划 = 状态为 pending 的所有计划
    lines.push('## 🎯 下周计划');
    lines.push('');
    if (pendingPlans.length === 0) {
      lines.push('_无待开始的计划_');
    } else {
      for (const p of pendingPlans) {
        const pri = PLAN_PRIORITY_LABEL[p.priority] || p.priority;
        lines.push(`- [ ] **${p.title}** _(${pri})_`);
      }
    }
    lines.push('');
  }

  if (sections.tips) {
    const tips = [];
    const completionRate = weekPlans.length > 0
      ? Math.round((donePlans.length / weekPlans.length) * 100)
      : 0;
    if (weekPlans.length > 0 && completionRate < 50) {
      tips.push(`完成率 ${completionRate}%，建议拆解大任务或调整优先级`);
    }
    if (inProgressPlans.length > 5) {
      tips.push(`进行中任务 ${inProgressPlans.length} 个偏多，建议聚焦 3 个核心`);
    }
    if (cancelledPlans.length > weekPlans.length * 0.3) {
      tips.push(`取消率 ${Math.round(cancelledPlans.length / weekPlans.length * 100)}% 偏高，需审视计划制定质量`);
    }
    if (tips.length === 0) {
      tips.push('本周执行健康，继续保持节奏 ✨');
    }
    lines.push('## 💡 改进建议');
    lines.push('');
    for (const t of tips) {
      lines.push(`- ${t}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 打开周报抽屉并自动生成
 */
async function openWeeklyReportDrawer() {
  const drawer = document.getElementById('report-drawer');
  if (!drawer) return;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('drawer-overlay')?.classList.add('open');
  // 自动生成一次
  await generateAndFillReport();
}

/**
 * 重新生成周报
 */
async function generateAndFillReport() {
  const output = document.getElementById('report-output');
  const meta = document.getElementById('report-meta');
  const which = document.getElementById('report-week-select')?.value || 'current';

  if (output) {
    output.value = '⏳ 正在汇总数据...';
  }
  if (meta) {
    meta.textContent = '';
  }
  // 禁用复制/下载
  const copyBtn = document.getElementById('report-copy');
  const dlBtn = document.getElementById('report-download');
  if (copyBtn) copyBtn.disabled = true;
  if (dlBtn) dlBtn.disabled = true;

  try {
    const t0 = Date.now();
    const md = await generateWeeklyReport(which);
    const took = Date.now() - t0;
    if (output) output.value = md;
    if (meta) meta.textContent = `✓ 生成完成，耗时 ${took}ms，长度 ${md.length} 字符`;
    if (copyBtn) copyBtn.disabled = false;
    if (dlBtn) dlBtn.disabled = false;
  } catch (e) {
    if (output) output.value = `❌ 生成失败：${e.message}`;
    if (meta) meta.textContent = '';
  }
}

/**
 * 复制周报到剪贴板
 */
async function copyWeeklyReport() {
  const output = document.getElementById('report-output');
  if (!output || !output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    showNotification('✓ 已复制到剪贴板', 'success');
  } catch (e) {
    // 降级方案
    output.select();
    document.execCommand('copy');
    showNotification('✓ 已复制（兼容模式）', 'success');
  }
}

/**
 * 下载周报为 .md 文件
 */
function downloadWeeklyReport() {
  const output = document.getElementById('report-output');
  if (!output || !output.value) return;
  const which = document.getElementById('report-week-select')?.value || 'current';
  const range = getReportWeekRange(which);
  const filename = `周报-${range.start}_${range.end}.md`;
  const blob = new Blob([output.value], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showNotification(`✓ 已下载 ${filename}`, 'success');
}

/**
 * 初始化周报生成器事件
 */
function initReportDrawer() {
  const btnOpen = document.getElementById('btn-plan-report');
  if (btnOpen) btnOpen.addEventListener('click', openWeeklyReportDrawer);
  const btnGen = document.getElementById('report-generate');
  if (btnGen) btnGen.addEventListener('click', generateAndFillReport);
  const btnCopy = document.getElementById('report-copy');
  if (btnCopy) btnCopy.addEventListener('click', copyWeeklyReport);
  const btnDl = document.getElementById('report-download');
  if (btnDl) btnDl.addEventListener('click', downloadWeeklyReport);
  const sel = document.getElementById('report-week-select');
  if (sel) sel.addEventListener('change', generateAndFillReport);
}

// 暴露到 window 以便 switchTab 懒调用
window.initPlan = initPlan;
window.initReportDrawer = initReportDrawer;
