// ======== v5.6.0 Prompt Library 模块 ========
//
// 独立提示词库：分类、模板 CRUD、变量渲染、一键创建任务。
// 暴露在 window.Prompts 命名空间下。

(function (global) {
  'use strict';

  const { state, api, escapeHtml, showNotification, formatRelative } = global.Core;
  const Main = global.Main;

  const promptState = {
    categories: [],
    prompts: [],
    search: '',
    currentCategoryId: null,
    editingId: null
  };

  async function initPrompts() {
    bindPromptEvents();
    await loadPrompts();
  }

  async function loadPrompts() {
    try {
      const { data } = await api('/api/prompts');
      promptState.categories = data.categories || [];
      promptState.prompts = data.prompts || [];
      state.promptCategories = promptState.categories;
      state.promptsList = promptState.prompts;
      renderPrompts();
      if (Main && Main.updateTabCounts) Main.updateTabCounts();
    } catch (e) {
      console.error('loadPrompts:', e);
      showNotification(`❌ 加载提示词库失败: ${e.message}`, 'error');
    }
  }

  function renderPrompts() {
    renderPromptCatFilter();
    renderPromptList();
  }

  function renderPromptCatFilter() {
    const select = document.getElementById('prompt-cat-filter');
    if (!select) return;
    const current = select.value || promptState.currentCategoryId || 'all';
    let html = '<option value="all">全部分类</option>';
    for (const c of promptState.categories) {
      html += `<option value="${c.id}">${escapeHtml(c.icon + ' ' + c.name)}</option>`;
    }
    select.innerHTML = html;
    select.value = current;
  }

  function getPromptCategoryName(categoryId) {
    const cat = promptState.categories.find((c) => c.id === categoryId);
    return cat ? `${cat.icon} ${cat.name}` : '未分类';
  }

  function renderPromptList() {
    const list = document.getElementById('prompt-list');
    if (!list) return;

    const q = promptState.search.toLowerCase();
    let items = promptState.prompts;
    if (promptState.currentCategoryId) {
      items = items.filter((p) => p.category_id === promptState.currentCategoryId);
    }
    if (q) {
      items = items.filter(
        (p) =>
          (p.title || '').toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q) ||
          (p.content || '').toLowerCase().includes(q) ||
          (p.tags || []).some((t) => (t || '').toLowerCase().includes(q))
      );
    }

    if (items.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📝</div>
          <div class="empty-text">暂无提示词</div>
          <div class="empty-hint">点击「🎁 演示数据」加载示例，或点击「+ 提示词」创建</div>
          <button class="btn-demo btn-demo-large" id="btn-prompt-seed-demo-3">🎁 一键加载演示数据</button>
        </div>`;
      document.getElementById('btn-prompt-seed-demo-3')?.addEventListener('click', seedPromptDemo);
      return;
    }

    list.innerHTML = items
      .map((p) => {
        const vars = (p.variables || [])
          .map((v) => `<span class="prompt-var-badge">{{${escapeHtml(v)}}}</span>`)
          .join('');
        const tags = (p.tags || []).map((t) => `<span class="prompt-tag">${escapeHtml(t)}</span>`).join('');
        const desc = p.description ? `<div class="prompt-card-desc">${escapeHtml(p.description)}</div>` : '';
        const preview = escapeHtml(
          (p.content || '').slice(0, 120).replace(/\n/g, ' ') + (p.content.length > 120 ? '…' : '')
        );
        return `
        <div class="prompt-card" data-prompt-id="${p.id}">
          <div class="prompt-card-header">
            <div class="prompt-card-title">${escapeHtml(p.title)}</div>
            <div class="prompt-card-actions">
              <button class="btn-icon" data-action="use" title="使用">▶️</button>
              <button class="btn-icon" data-action="edit" title="编辑">✏️</button>
              <button class="btn-icon" data-action="delete" title="删除">🗑️</button>
            </div>
          </div>
          ${desc}
          <div class="prompt-card-preview">${preview}</div>
          <div class="prompt-card-footer">
            <div class="prompt-card-meta">
              <span class="prompt-card-cat">${escapeHtml(getPromptCategoryName(p.category_id))}</span>
              ${vars ? `<span class="prompt-card-vars">${vars}</span>` : ''}
            </div>
            <div class="prompt-card-tags">${tags}</div>
            <div class="prompt-card-time">${formatRelative(p.updated_at)}</div>
          </div>
        </div>`;
      })
      .join('');

    list.querySelectorAll('.prompt-card').forEach((card) => {
      const id = card.getAttribute('data-prompt-id');
      card.querySelector('[data-action="use"]')?.addEventListener('click', () => usePrompt(id));
      card.querySelector('[data-action="edit"]')?.addEventListener('click', () => openPromptDrawer(id));
      card.querySelector('[data-action="delete"]')?.addEventListener('click', () => deletePrompt(id));
    });
  }

  function openPromptDrawer(id) {
    const isEdit = !!id;
    const p = isEdit ? promptState.prompts.find((x) => x.id === id) : null;
    promptState.editingId = id || null;

    document.getElementById('prompt-drawer-title').textContent = isEdit ? '📝 编辑提示词' : '📝 新建提示词';
    document.getElementById('prompt-drawer-title-input').value = p?.title || '';
    document.getElementById('prompt-drawer-desc-input').value = p?.description || '';
    document.getElementById('prompt-drawer-content-input').value = p?.content || '';
    document.getElementById('prompt-drawer-tags-input').value = (p?.tags || []).join(', ');
    document.getElementById('prompt-drawer-delete').style.display = isEdit ? '' : 'none';

    const catSelect = document.getElementById('prompt-drawer-cat-select');
    catSelect.innerHTML = promptState.categories
      .map((c) => `<option value="${c.id}">${escapeHtml(c.icon + ' ' + c.name)}</option>`)
      .join('');
    catSelect.value = p?.category_id || promptState.currentCategoryId || promptState.categories[0]?.id || '__orphan__';

    document.getElementById('prompt-drawer-meta').textContent = isEdit
      ? `ID: ${p.id} · 变量: ${(p.variables || []).join(', ') || '无'}`
      : '支持 {{变量名}} 占位符';

    if (Main && Main.openDrawer) Main.openDrawer('prompt-drawer');
  }

  async function savePromptDrawer() {
    const title = document.getElementById('prompt-drawer-title-input').value.trim();
    const content = document.getElementById('prompt-drawer-content-input').value.trim();
    const description = document.getElementById('prompt-drawer-desc-input').value.trim();
    const categoryId = document.getElementById('prompt-drawer-cat-select').value;
    const tags = document
      .getElementById('prompt-drawer-tags-input')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    if (!title || !content) {
      showNotification('标题和内容不能为空', 'error');
      return;
    }

    const body = { category_id: categoryId, title, content, description, tags };
    try {
      if (promptState.editingId) {
        await api(`/api/prompts/${promptState.editingId}`, { method: 'PATCH', body });
      } else {
        await api('/api/prompts', { method: 'POST', body });
      }
      if (Main && Main.closeDrawer) Main.closeDrawer('prompt-drawer');
      await loadPrompts();
      showNotification('✓ 保存成功', 'success');
    } catch (e) {
      showNotification(`❌ 保存失败: ${e.message}`, 'error');
    }
  }

  async function deletePrompt(id) {
    const p = promptState.prompts.find((x) => x.id === id);
    if (!p) return;
    const ok = confirm(`确认删除提示词「${p.title}」？`);
    if (!ok) return;
    try {
      await api(`/api/prompts/${id}`, { method: 'DELETE' });
      await loadPrompts();
      showNotification('✓ 已删除', 'success');
    } catch (e) {
      showNotification(`❌ 删除失败: ${e.message}`, 'error');
    }
  }

  async function seedPromptDemo() {
    try {
      const { data } = await api('/api/prompts/seed-demo', { method: 'POST' });
      await loadPrompts();
      showNotification(`✓ 已加载 ${data.prompts_added} 个示例提示词`, 'success');
    } catch (e) {
      showNotification(`❌ 加载失败: ${e.message}`, 'error');
    }
  }

  async function usePrompt(id) {
    const p = promptState.prompts.find((x) => x.id === id);
    if (!p) return;
    const variables = {};
    for (const v of p.variables || []) {
      const val = prompt(`请输入 {{${v}}} 的值：`);
      if (val === null) return;
      variables[v] = val;
    }
    try {
      const { data } = await api(`/api/prompts/${id}/use`, {
        method: 'POST',
        body: { variables }
      });
      showNotification(`✓ 已创建任务 ${data.task_id}`, 'success');
      if (Main && Main.switchTab) Main.switchTab('chat');
    } catch (e) {
      showNotification(`❌ 创建任务失败: ${e.message}`, 'error');
    }
  }

  async function createPromptCategory() {
    const name = prompt('请输入新分类名称：');
    if (!name || !name.trim()) return;
    try {
      await api('/api/prompts/categories', { method: 'POST', body: { name } });
      await loadPrompts();
      showNotification('✓ 分类创建成功', 'success');
    } catch (e) {
      showNotification(`❌ 创建分类失败: ${e.message}`, 'error');
    }
  }

  function bindPromptEvents() {
    document.getElementById('prompt-search')?.addEventListener('input', (e) => {
      promptState.search = e.target.value.trim();
      renderPromptList();
    });
    document.getElementById('prompt-cat-filter')?.addEventListener('change', (e) => {
      promptState.currentCategoryId = e.target.value === 'all' ? null : e.target.value;
      renderPromptList();
    });
    document.getElementById('btn-prompt-new')?.addEventListener('click', () => openPromptDrawer(null));
    document.getElementById('btn-prompt-new-category')?.addEventListener('click', createPromptCategory);
    document.getElementById('btn-prompt-seed-demo')?.addEventListener('click', seedPromptDemo);
    document.getElementById('btn-prompt-seed-demo-2')?.addEventListener('click', seedPromptDemo);

    document.getElementById('prompt-drawer-cancel')?.addEventListener('click', () => {
      if (Main && Main.closeDrawer) Main.closeDrawer('prompt-drawer');
    });
    document.getElementById('prompt-drawer-save')?.addEventListener('click', savePromptDrawer);
    document.getElementById('prompt-drawer-delete')?.addEventListener('click', () => {
      if (promptState.editingId) deletePrompt(promptState.editingId);
    });
    document.querySelectorAll('[data-close="prompt-drawer"]').forEach((b) => {
      b.addEventListener('click', () => {
        if (Main && Main.closeDrawer) Main.closeDrawer('prompt-drawer');
      });
    });
  }

  // 暴露到 window
  global.Prompts = {
    initPrompts,
    loadPrompts,
    renderPrompts,
    openPromptDrawer,
    savePromptDrawer,
    deletePrompt,
    seedPromptDemo,
    usePrompt
  };
  global.initPrompts = initPrompts;
})(window);
