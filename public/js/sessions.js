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
      const projectDirBadge = s.project_dir
        ? `<div class="session-project-dir" title="项目目录（任务执行 cwd）"><span class="dir-icon">📂</span><code>${escapeHtml(s.project_dir)}</code></div>`
        : '';
      return `
        <div class="session-item ${isActive ? 'active' : ''} ${s.status === 'archived' ? 'archived' : ''} ${isDefault ? 'default' : ''}"
             data-session-id="${s.id}">
          <div class="session-item-header">
            <div class="session-item-name">${escapeHtml(s.name)}</div>
            <div class="session-item-count">${s.task_count || 0}</div>
          </div>
          ${s.last_task_summary ? `<div class="session-item-summary">${escapeHtml(s.last_task_summary)}</div>` : ''}
          ${projectDirBadge}
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
    await showSessionEditor({ title: '新建会话', onSubmit: async (data) => {
      try {
        const { data: session } = await api('/api/sessions', { method: 'POST', body: data });
        showNotification(`✅ 会话已创建: ${session.name}`, 'success');
        await loadSessions();
        selectSession(session.id);
      } catch (e) {
        showNotification(`❌ 创建失败: ${e.message}`, 'error');
      }
    }});
  }

  async function renameSession(sessionId) {
    const s = state.sessions.find(s => s.id === sessionId);
    if (!s) return;
    await showSessionEditor({
      title: '编辑会话',
      initial: { name: s.name, description: s.description || '', project_dir: s.project_dir || '' },
      onSubmit: async (data) => {
        try {
          await api(`/api/sessions/${sessionId}`, { method: 'PATCH', body: data });
          showNotification('✅ 已保存', 'success');
          await loadSessions();
        } catch (e) {
          showNotification(`❌ 失败: ${e.message}`, 'error');
        }
      }
    });
  }

  /**
   * v5.4.4: 会话编辑模态框（含项目目录预设下拉 + 自定义输入 + 实时校验）
   */
  async function showSessionEditor({ title, initial, onSubmit }) {
    let presets = [];
    let presetsMeta = { common: 0, discovered: 0, recent: 0 };
    try {
      const r = await api('/api/sessions/project-dirs/presets');
      presets = r.data || [];
      presetsMeta = (r.meta && r.meta.sources) || presetsMeta;
    } catch (e) {
      console.warn('加载项目目录预设失败:', e.message);
    }

    const initialProject = (initial && initial.project_dir) || '';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width: 600px;">
        <div class="modal-header">${escapeHtml(title)}</div>
        <div class="modal-body">
          <label>会话名称 *</label>
          <input type="text" name="name" required value="${escapeHtml((initial && initial.name) || '')}" placeholder="如：商品价格监控">

          <label>描述（可选）</label>
          <textarea name="description" placeholder="会话用途备注">${escapeHtml((initial && initial.description) || '')}</textarea>

          <label>项目目录（可选，agent 将以此为 cwd 执行命令）</label>
          <div class="project-dir-row">
            <select name="project_dir_preset" class="project-dir-preset" size="1">
              <option value="">— 选择预设目录（共 ${presets.length} 个）—</option>
              ${presets.map(p => `<option value="${escapeHtml(p.path)}" data-category="${p.category}">${escapeHtml(p.label)} — ${escapeHtml(p.path)}</option>`).join('')}
            </select>
            <span class="project-dir-divider">或</span>
            <input type="text" name="project_dir" class="project-dir-input" value="${escapeHtml(initialProject)}" placeholder="/绝对路径/项目根（必须存在）">
          </div>
          <div class="project-dir-status" data-status></div>
          <div class="project-dir-meta">
            ${renderPresetSourcesLegend(presetsMeta)}
            <span class="project-dir-clear">
              <button type="button" class="modal-btn" data-action="clear-dir" style="padding: 2px 8px; font-size: 11px;">✕ 清空</button>
              <button type="button" class="modal-btn" data-action="use-home" style="padding: 2px 8px; font-size: 11px;">🏠 HOME</button>
            </span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn" data-action="cancel">取消</button>
          <button class="modal-btn modal-btn-primary" data-action="confirm">确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const presetSel = overlay.querySelector('select[name="project_dir_preset"]');
    const dirInput = overlay.querySelector('input[name="project_dir"]');
    const statusEl = overlay.querySelector('.project-dir-status');

    // 预设变化 → 填到输入框
    presetSel.addEventListener('change', () => {
      const v = presetSel.value;
      if (v) {
        dirInput.value = v;
        validateDir(dirInput.value);
      }
    });

    // 输入变化 → 清掉预设选中
    dirInput.addEventListener('input', () => {
      // 找到匹配的预设，取消选中
      if (presetSel.value && presetSel.value !== dirInput.value) {
        presetSel.value = '';
      }
      scheduleValidate();
    });

    // 清空
    overlay.querySelector('[data-action="clear-dir"]').addEventListener('click', () => {
      dirInput.value = '';
      presetSel.value = '';
      statusEl.innerHTML = '';
    });
    // HOME（从预设中找，或用 /root 兜底）
    overlay.querySelector('[data-action="use-home"]').addEventListener('click', () => {
      // 找预设中的 home 目录
      const homePreset = presets.find(p => p.path === (state.userHome || '/root') || p.label.includes('HOME'));
      const home = (homePreset && homePreset.path) || (state.userHome) || '/root';
      dirInput.value = home;
      presetSel.value = home;
      validateDir(home);
    });

    // 防抖校验
    let validateTimer = null;
    function scheduleValidate() {
      if (validateTimer) clearTimeout(validateTimer);
      validateTimer = setTimeout(() => validateDir(dirInput.value), 350);
    }
    async function validateDir(p) {
      if (!p || !p.trim()) {
        statusEl.innerHTML = '<span class="dir-status-empty">未设置（任务将不绑定项目目录）</span>';
        return;
      }
      statusEl.innerHTML = '<span class="dir-status-checking">⏳ 校验中…</span>';
      try {
        const r = await api('/api/sessions/project-dirs/validate', {
          method: 'POST',
          body: { path: p.trim() }
        });
        if (r.valid) {
          statusEl.innerHTML = `<span class="dir-status-ok">✓ 已验证：${escapeHtml(r.normalized)}</span>`;
        } else {
          statusEl.innerHTML = `<span class="dir-status-err">✗ ${escapeHtml(r.error || '路径无效')}</span>`;
        }
      } catch (e) {
        statusEl.innerHTML = `<span class="dir-status-err">✗ 校验失败：${escapeHtml(e.message)}</span>`;
      }
    }

    // 初次校验
    if (initialProject) validateDir(initialProject);
    else statusEl.innerHTML = '<span class="dir-status-empty">未设置（任务将不绑定项目目录）</span>';

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
    overlay.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
      const data = {
        name: overlay.querySelector('input[name="name"]').value.trim(),
        description: overlay.querySelector('textarea[name="description"]').value.trim(),
        project_dir: dirInput.value.trim()
      };
      if (!data.name) {
        showNotification('⚠️ 会话名称不能为空', 'warning');
        return;
      }
      // 提交前再校验一次（避免空预设漏校验）
      if (data.project_dir) {
        try {
          const r = await api('/api/sessions/project-dirs/validate', {
            method: 'POST',
            body: { path: data.project_dir }
          });
          if (!r.valid) {
            showNotification(`❌ ${r.error || '项目目录无效'}`, 'error');
            return;
          }
          data.project_dir = r.normalized;
        } catch (e) {
          showNotification(`❌ 校验失败: ${e.message}`, 'error');
          return;
        }
      } else {
        // 空字符串 → undefined（清空）
        data.project_dir = undefined;
      }
      close();
      await onSubmit(data);
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    setTimeout(() => {
      const firstInput = overlay.querySelector('input[name="name"]');
      if (firstInput) firstInput.focus();
    }, 100);
  }

  function renderPresetSourcesLegend(meta) {
    return `
      <span class="preset-source-legend">
        <span class="src-common">🏠 常用 (${meta.common})</span>
        <span class="src-discovered">📦 发现 (${meta.discovered})</span>
        <span class="src-recent">🕘 最近 (${meta.recent})</span>
      </span>
    `;
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
