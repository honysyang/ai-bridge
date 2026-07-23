// ======== v5.2.0 Tasks 模块 ========
//
// 任务管理：加载、渲染、详情查看、提交/重试/删除、消息输入。

(function (global) {
  'use strict';

  const { state, i18n, api, escapeHtml, formatTime, formatRelative, showNotification, setHash } = global.Core;

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
      if (meta?.queue_stats && global.updateQueueStats) global.updateQueueStats(meta.queue_stats);
    } catch (e) {
      console.error('loadTasks:', e);
      showNotification(`❌ 加载任务失败: ${e.message}`, 'error', 4000);
    }
  }

  function renderTasks() {
    const container = document.getElementById('task-flow');
    if (!container) return;
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
    if (body) body.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">加载中...</div></div>`;

    try {
      const { data: task } = await api(`/api/tasks/${taskId}`);
      renderDetail(task);
    } catch (e) {
      if (body) body.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-text">${escapeHtml(e.message)}</div></div>`;
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
          <button onclick="Tasks.copyToClipboard('${escapeHtml(msgId)}', 'msgId')">📋 复制 msgId</button>
          <button onclick="Tasks.copyToClipboard('${escapeHtml(wxid)}', 'wxid')">📋 复制 wxid</button>
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
      if (global.Sessions) await global.Sessions.loadSessions();
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

  // 暴露到 window
  global.Tasks = {
    loadTasks,
    renderTasks,
    selectTask,
    loadTaskDetail,
    renderDetail,
    renderDetailOverview,
    renderDetailEvidence,
    renderDetailTimeline,
    renderWechatSourceSection,
    copyToClipboard,
    bindDetailActions,
    enableCompose,
    submitCompose,
    autoResizeInput
  };

  // 兼容老代码：bindEvents 中可能引用 copyToClipboard
  global.copyToClipboard = copyToClipboard;
})(window);
