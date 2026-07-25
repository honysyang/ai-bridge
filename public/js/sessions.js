// ======== v5.2.0 Sessions 模块 ========
//
// 会话管理：列表加载、选择、新建、重命名、归档、删除。
// 通过 window.Core 访问共享状态和工具。

(function (global) {
  'use strict';

  const { state, api, escapeHtml, formatRelative, showNotification, setHash } = global.Core;

  function showSkeletonSessions() {
    const container = document.getElementById('session-list');
    if (!container) return;
    container.innerHTML = Array.from({ length: 5 })
      .map(
        () => `
      <div class="skeleton-card">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-text"></div>
        <div class="skeleton skeleton-text" style="width:70%"></div>
      </div>`
      )
      .join('');
  }

  async function loadSessions() {
    showSkeletonSessions();
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

    container.innerHTML = state.sessions
      .map((s) => {
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
          ${
            !isDefault
              ? `
          <div class="session-item-actions">
            <button class="session-action-btn" data-action="rename" data-session-id="${s.id}" title="重命名">✎</button>
            <button class="session-action-btn" data-action="archive" data-session-id="${s.id}" title="归档">📦</button>
            <button class="session-action-btn danger" data-action="delete" data-session-id="${s.id}" title="删除">🗑</button>
          </div>`
              : ''
          }
        </div>`;
      })
      .join('');
  }

  function selectSession(sessionId) {
    state.currentSessionId = sessionId;
    state.currentTaskId = null;
    renderSessions();
    // 修复 v5.2.1：loadTasks/enableCompose 在 global.Tasks，不是 global.Core
    if (global.Tasks && global.Tasks.loadTasks) global.Tasks.loadTasks();
    if (global.Tasks && global.Tasks.enableCompose) global.Tasks.enableCompose(true);
    document.getElementById('middle-title').textContent =
      `📌 ${state.sessions.find((s) => s.id === sessionId)?.name || '任务流'}`;
    document.getElementById('detail-body').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👈</div>
        <div class="empty-text">选择任务查看详情</div>
        <div class="empty-hint">点击中间栏的任务卡片</div>
      </div>`;
    setHash(`#session/${sessionId}`);
  }

  async function createSession() {
    await showSessionEditor({
      title: '新建会话',
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
    const s = state.sessions.find((s) => s.id === sessionId);
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
   * v5.4.5: 会话编辑模态框
   * - 简化：单一文本输入 + 实时路径补全（类似 shell tab 补全）
   * - 候选项随输入变化而变化
   * - 提交前校验；无效则禁用确定
   */
  async function showSessionEditor({ title, initial, onSubmit }) {
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
          <div class="project-dir-autocomplete">
            <input type="text" name="project_dir" class="project-dir-input" value="${escapeHtml(initialProject)}" placeholder="/输入路径，下方显示候选项" autocomplete="off" spellcheck="false">
            <div class="project-dir-suggest" data-suggest></div>
          </div>
          <div class="project-dir-status" data-status></div>
          <div class="project-dir-meta">
            <span class="project-dir-hint">💡 提示：输入路径时下方显示候选目录，点击或按 Tab 自动补全</span>
            <span class="project-dir-clear">
              <button type="button" class="modal-btn" data-action="clear-dir" style="padding: 2px 8px; font-size: 11px;">✕ 清空</button>
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

    const dirInput = overlay.querySelector('input[name="project_dir"]');
    const suggestEl = overlay.querySelector('.project-dir-suggest');
    const statusEl = overlay.querySelector('.project-dir-status');
    const confirmBtn = overlay.querySelector('[data-action="confirm"]');

    // 状态：当前是否已验证（仅在用户停止输入后做完整校验）
    let isValid = !initialProject; // 初始无值 → 允许空提交；有值则需校验
    let lastValidated = initialProject;

    // ======== 补全 ========
    let suggestTimer = null;
    let suggestSeq = 0; // 防止竞态（旧响应覆盖新响应）

    function scheduleSuggest() {
      if (suggestTimer) clearTimeout(suggestTimer);
      suggestTimer = setTimeout(fetchSuggest, 180);
    }

    async function fetchSuggest() {
      const prefix = dirInput.value;
      const mySeq = ++suggestSeq;
      if (!prefix && !dirInput._touched) {
        // 首次聚焦空输入时不主动补全（避免一开始就刷一堆）
        suggestEl.innerHTML = '';
        return;
      }
      try {
        const r = await api('/api/fs/suggest', {
          method: 'POST',
          body: { prefix }
        });
        if (mySeq !== suggestSeq) return; // 过期
        const cands = (r.data && r.data.candidates) || [];
        if (cands.length === 0) {
          suggestEl.innerHTML = '<div class="suggest-empty">无匹配目录</div>';
        } else {
          suggestEl.innerHTML = cands
            .map(
              (c, i) => `
            <div class="suggest-item" data-idx="${i}" data-path="${escapeHtml(c.path)}">
              <span class="suggest-name">${escapeHtml(c.name)}</span>
              <span class="suggest-path">${escapeHtml(c.path)}</span>
              ${c.marker ? `<span class="suggest-marker" title="项目标记：${escapeHtml(c.marker)}">📦</span>` : ''}
            </div>
          `
            )
            .join('');
          // 绑定点击
          suggestEl.querySelectorAll('.suggest-item').forEach((el) => {
            el.addEventListener('mousedown', (ev) => {
              // mousedown 而非 click：避免 input blur 抢先关闭建议框
              ev.preventDefault();
              const p = el.dataset.path;
              dirInput.value = p + '/';
              dirInput.focus();
              dirInput.setSelectionRange(p.length + 1, p.length + 1);
              scheduleSuggest();
            });
          });
        }
      } catch (e) {
        suggestEl.innerHTML = `<div class="suggest-empty">补全失败: ${escapeHtml(e.message)}</div>`;
      }
    }

    // ======== 校验 ========
    let validateTimer = null;
    function scheduleValidate() {
      if (validateTimer) clearTimeout(validateTimer);
      validateTimer = setTimeout(validateDir, 400);
    }

    async function validateDir() {
      const p = dirInput.value.trim();
      if (!p) {
        statusEl.innerHTML = '<span class="dir-status-empty">未设置（任务将不绑定项目目录）</span>';
        isValid = true;
        confirmBtn.disabled = false;
        lastValidated = '';
        return;
      }
      statusEl.innerHTML = '<span class="dir-status-checking">⏳ 校验中…</span>';
      try {
        const r = await api('/api/sessions/project-dirs/validate', {
          method: 'POST',
          body: { path: p }
        });
        if (r.valid) {
          statusEl.innerHTML = `<span class="dir-status-ok">✓ ${escapeHtml(r.normalized)}</span>`;
          isValid = true;
          lastValidated = r.normalized;
          confirmBtn.disabled = false;
        } else {
          statusEl.innerHTML = `<span class="dir-status-err">✗ ${escapeHtml(r.error || '路径无效')}</span>`;
          isValid = false;
          confirmBtn.disabled = true;
        }
      } catch (e) {
        statusEl.innerHTML = `<span class="dir-status-err">✗ 校验失败：${escapeHtml(e.message)}</span>`;
        isValid = false;
        confirmBtn.disabled = true;
      }
    }

    // ======== 事件 ========
    dirInput.addEventListener('input', () => {
      dirInput._touched = true;
      scheduleSuggest();
      // 输入时把校验态置为"待重新校验"
      if (dirInput.value.trim() !== lastValidated) {
        statusEl.innerHTML = '<span class="dir-status-pending">… 输入已变更，待校验</span>';
        isValid = false;
        confirmBtn.disabled = true;
      }
    });
    dirInput.addEventListener('blur', () => {
      // 延迟关闭建议（让点击 mousedown 先触发）
      setTimeout(() => {
        suggestEl.innerHTML = '';
        validateDir();
      }, 200);
    });
    dirInput.addEventListener('focus', () => {
      dirInput._touched = true;
      fetchSuggest();
    });
    dirInput.addEventListener('keydown', (e) => {
      // Tab：补全第一个候选
      if (e.key === 'Tab') {
        const first = suggestEl.querySelector('.suggest-item');
        if (first) {
          e.preventDefault();
          const p = first.dataset.path;
          dirInput.value = p + '/';
          dirInput.setSelectionRange(p.length + 1, p.length + 1);
          scheduleSuggest();
        }
      }
      // Enter：触发校验 + 提交
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isValid) {
          validateDir().then(() => {
            if (isValid) confirmBtn.click();
          });
        } else {
          confirmBtn.click();
        }
      }
    });

    // 清空
    overlay.querySelector('[data-action="clear-dir"]').addEventListener('click', () => {
      dirInput.value = '';
      dirInput._touched = true;
      suggestEl.innerHTML = '';
      statusEl.innerHTML = '<span class="dir-status-empty">未设置（任务将不绑定项目目录）</span>';
      isValid = true;
      lastValidated = '';
      confirmBtn.disabled = false;
      dirInput.focus();
    });

    // 初次校验（如有初值）
    if (initialProject) {
      dirInput._touched = true;
      validateDir();
    } else {
      statusEl.innerHTML = '<span class="dir-status-empty">未设置（任务将不绑定项目目录）</span>';
    }

    // ======== 关闭 + 提交 ========
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
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
      // 最终校验
      if (data.project_dir) {
        if (!isValid || data.project_dir !== lastValidated) {
          await validateDir();
          if (!isValid) {
            showNotification('❌ 项目目录无效，无法保存', 'error');
            return;
          }
          data.project_dir = lastValidated;
        } else {
          data.project_dir = lastValidated;
        }
      } else {
        data.project_dir = undefined;
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
      const firstInput = overlay.querySelector('input[name="name"]');
      if (firstInput) firstInput.focus();
    }, 100);
  }

  async function archiveSession(sessionId) {
    const ok = await global.Core.openConfirm({
      title: '归档会话',
      message: '归档此会话？\n（任务保留，可在归档列表查看）',
      confirmText: '归档'
    });
    if (!ok) return;
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
    const ok = await global.Core.openConfirm({
      title: '删除会话',
      message: '删除此会话？\n（其任务会重新归属到默认会话，数据不丢失）',
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
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
