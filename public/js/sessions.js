// ======== v5.2.0 Sessions 模块 ========
//
// 会话管理：列表加载、选择、新建、重命名、归档、删除。
// 通过 window.Core 访问共享状态和工具。

(function (global) {
  'use strict';

  const { state, api, escapeHtml, formatRelative, showNotification, setHash } = global.Core;

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
      showNotification(`❌ 加载会话失败: ${e.message}`, 'error', 4000);
    }
  }

  function renderSessions() {
    const container = document.getElementById('session-list');
    if (!container) return;
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
    // 修复 v5.2.1：loadTasks/enableCompose 在 global.Tasks，不是 global.Core
    if (global.Tasks && global.Tasks.loadTasks) global.Tasks.loadTasks();
    if (global.Tasks && global.Tasks.enableCompose) global.Tasks.enableCompose(true);
    document.getElementById('middle-title').textContent =
      `📌 ${state.sessions.find(s => s.id === sessionId)?.name || '任务流'}`;
    document.getElementById('detail-body').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👈</div>
        <div class="empty-text">选择任务查看详情</div>
        <div class="empty-hint">点击中间栏的任务卡片</div>
      </div>`;
    setHash(`#session/${sessionId}`);
  }

  async function createSession() {
    if (global.Main && global.Main.showModal) {
      global.Main.showModal({
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
  }

  async function renameSession(sessionId) {
    const s = state.sessions.find(s => s.id === sessionId);
    if (!s) return;
    if (global.Main && global.Main.showModal) {
      global.Main.showModal({
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
  }

  async function archiveSession(sessionId) {
    if (!confirm('归档此会话？\n（任务保留，可在归档列表查看）')) return;
    try {
      await api(`/api/sessions/${sessionId}`, { method: 'PATCH', body: { status: 'archived' } });
      showNotification('📦 已归档', 'success');
      if (state.currentSessionId === sessionId) {
        state.currentSessionId = null;
        // 修复 v5.2.1：enableCompose 在 global.Tasks
        if (global.Tasks && global.Tasks.enableCompose) global.Tasks.enableCompose(false);
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

  // 暴露到 window
  global.Sessions = {
    loadSessions,
    renderSessions,
    selectSession,
    createSession,
    renameSession,
    archiveSession,
    deleteSession
  };
})(window);
