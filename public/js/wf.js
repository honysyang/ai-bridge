// ======== v5.2.0 Workflows 模块 ========
//
// 工作流：模板列表、CRUD、执行。

(function (global) {
  'use strict';

  const { state, i18n, api, escapeHtml, formatRelative, showNotification } = global.Core;
  function openDrawer(id) {
    if (global.Main && global.Main.openDrawer) global.Main.openDrawer(id);
  }
  function closeDrawer(id) {
    if (global.Main && global.Main.closeDrawer) global.Main.closeDrawer(id);
  }
  function switchTab(name, opts) {
    if (global.Main && global.Main.switchTab) global.Main.switchTab(name, opts);
  }

  async function initWF() {
    bindWFEvents();
    await loadWorkflows();
  }

  function bindWFEvents() {
    const search = document.getElementById('wf-search');
    if (search) {
      let timer;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => renderWFList(), 200);
      });
    }
    document.getElementById('btn-wf-new')?.addEventListener('click', () => openWFEditor(null));
    document.getElementById('btn-wf-seed-demo')?.addEventListener('click', seedWFDemo);
    document.getElementById('btn-wf-seed-demo-2')?.addEventListener('click', seedWFDemo);
    const drawer = document.getElementById('wf-drawer');
    if (drawer) {
      document.getElementById('wf-drawer-cancel')?.addEventListener('click', () => closeDrawer('wf-drawer'));
      document.getElementById('wf-drawer-save')?.addEventListener('click', saveWFFromDrawer);
      document.getElementById('wf-drawer-delete')?.addEventListener('click', deleteWFFromDrawer);
      document.getElementById('wf-add-step')?.addEventListener('click', () => addWFStepUI());
      drawer
        .querySelectorAll('[data-close="wf-drawer"]')
        .forEach((b) => b.addEventListener('click', () => closeDrawer('wf-drawer')));
    }
  }

  async function loadWorkflows() {
    try {
      const { data } = await api('/api/wf');
      state.workflows = data || [];
      renderWFList();
      if (global.Main && global.Main.updateTabCounts) global.Main.updateTabCounts();
    } catch (e) {
      console.error('loadWorkflows:', e);
      showNotification(`❌ 加载工作流失败: ${e.message}`, 'error', 4000);
    }
  }

  async function seedWFDemo() {
    const ok = await global.Core.openConfirm({
      title: '加载示例工作流',
      message:
        '将追加 9 个示例工作流（股票分析、天气推送、销售月报、财务对账、客情回访、告警响应、代码重构、周报、客服回复）。\n已存在的工作流会自动跳过。\n继续？',
      confirmText: '继续'
    });
    if (!ok) return;
    const btn = document.getElementById('btn-wf-seed-demo');
    const btn2 = document.getElementById('btn-wf-seed-demo-2');
    const old1 = btn?.innerHTML,
      old2 = btn2?.innerHTML;
    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ 加载中…';
      }
      if (btn2) {
        btn2.disabled = true;
        btn2.innerHTML = '⏳ 加载中…';
      }
      const { data, message } = await api('/api/wf/seed-demo', { method: 'POST' });
      showNotification(`✓ ${message}`, 'success', 4000);
      await loadWorkflows();
    } catch (e) {
      showNotification(`❌ ${e.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = old1 || '🎁 演示数据';
      }
      if (btn2) {
        btn2.disabled = false;
        btn2.innerHTML = old2 || '🎁 一键加载演示数据';
      }
    }
  }

  function renderWFList() {
    const side = document.getElementById('wf-side');
    const main = document.getElementById('wf-main');
    if (!side) return;

    const q = (document.getElementById('wf-search')?.value || '').toLowerCase();
    const list = state.workflows.filter(
      (w) => !q || w.name.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q)
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

    side.innerHTML = list
      .map(
        (w) => `
      <div class="wf-item ${state.currentWorkflowId === w.id ? 'active' : ''}" data-wf-id="${w.id}">
        <span class="wf-item-icon">${escapeHtml(w.icon || '⚙️')}</span>
        <div class="wf-item-info">
          <div class="wf-item-name">${escapeHtml(w.name)}</div>
          <div class="wf-item-meta">${(w.steps || []).length} 步</div>
        </div>
      </div>
    `
      )
      .join('');

    side.querySelectorAll('.wf-item').forEach((el) => {
      el.addEventListener('click', () => selectWorkflow(el.dataset.wfId));
    });

    if (state.currentWorkflowId && state.workflows.find((w) => w.id === state.currentWorkflowId)) {
      renderWFDetail(state.currentWorkflowId);
    } else if (list.length > 0) {
      selectWorkflow(list[0].id);
    }
  }

  function selectWorkflow(id) {
    state.currentWorkflowId = id;
    document.querySelectorAll('.wf-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.wfId === id);
    });
    renderWFDetail(id);
  }

  function renderWFDetail(id) {
    const main = document.getElementById('wf-main');
    if (!main) return;
    const wf = state.workflows.find((w) => w.id === id);
    if (!wf) {
      main.innerHTML = `<div class="wf-empty"><div class="empty-icon">⚙️</div><div class="empty-text">未找到工作流</div></div>`;
      return;
    }

    const stepsHtml = (wf.steps || [])
      .map((s, i) => {
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
      })
      .join('');

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
    const ok = await global.Core.openConfirm({
      title: '执行工作流',
      message: '执行此工作流将创建一批任务，确定继续？',
      confirmText: '执行'
    });
    if (!ok) return;
    try {
      const { data } = await api(`/api/wf/${id}/execute`, {
        method: 'POST',
        body: { session_id: sessionId }
      });
      showNotification(`✓ 已创建 ${data.task_ids.length} 个任务`, 'success');
      switchTab('chat');
      if (global.Tasks) await global.Tasks.loadTasks();
    } catch (e) {
      showNotification(`❌ ${e.message}`, 'error');
    }
  }

  function openWFEditor(id) {
    const drawer = document.getElementById('wf-drawer');
    if (!drawer) return;
    const wf = id ? state.workflows.find((w) => w.id === id) : null;
    document.getElementById('wf-drawer-title').textContent = wf ? '✏️ 编辑工作流' : '⚙️ 新建工作流';
    document.getElementById('wf-drawer-name-input').value = wf?.name || '';
    document.getElementById('wf-drawer-icon-input').value = wf?.icon || '⚙️';
    document.getElementById('wf-drawer-desc-input').value = wf?.description || '';

    const stepsList = document.getElementById('wf-steps-list');
    if (stepsList) {
      stepsList.innerHTML = '';
      const steps = wf?.steps || [
        { id: `step-${Date.now()}`, name: '步骤 1', content: '', task_type: 'chat', priority: 'normal' }
      ];
      steps.forEach((s) => addWFStepUI(s));
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

    const steps = Array.from(stepEls)
      .map((el, i) => ({
        id: el.dataset.stepId || `step-${i}-${Date.now()}`,
        name: el.querySelector('.wf-step-name-input').value.trim() || `步骤 ${i + 1}`,
        content: el.querySelector('.wf-step-content-input').value.trim(),
        task_type: el.querySelector('.wf-step-type-input').value,
        priority: el.querySelector('.wf-step-priority-input').value
      }))
      .filter((s) => s.content);

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
    const ok = await global.Core.openConfirm({
      title: '删除工作流',
      message: '确认删除此工作流？',
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
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

  global.WF = {
    initWF,
    loadWorkflows,
    renderWFList,
    selectWorkflow,
    renderWFDetail,
    executeWF,
    openWFEditor,
    addWFStepUI,
    saveWFFromDrawer,
    deleteWFFromDrawer,
    seedWFDemo
  };
})(window);
