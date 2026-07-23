// ======== v5.2.0 Knowledge Base 模块 ========
//
// 知识库：分类、条目 CRUD、知识图谱（v4.3）、演示数据。
// 暴露在 window.KB 命名空间下。

(function (global) {
  'use strict';

  const { state, api, escapeHtml, formatRelative, showNotification, openDrawer, closeDrawer, switchTab } = global.Core;

  // ======== 状态（持久化到 localStorage）========
  const KB_STORAGE_KEY = 'kb-state-v1';
  const kbState = {
    categories: [],
    items: [],
    searchKeyword: '',
    expanded: {},
    collapsed: false,
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
    loadKBState();
    bindKBEvents();
    await loadKB();
  }

  function bindKBEvents() {
    document.querySelectorAll('#kb-view-tabs .tab').forEach(t => {
      t.addEventListener('click', () => switchKBView(t.dataset.view));
    });
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
    const catFilter = document.getElementById('kb-cat-filter');
    if (catFilter) {
      catFilter.addEventListener('change', (e) => {
        state.currentKbCategoryId = e.target.value === 'all' ? null : e.target.value;
        renderKBItems();
      });
    }
    const btnNewCat = document.getElementById('btn-kb-new-category');
    if (btnNewCat) btnNewCat.addEventListener('click', () => openKBCategoryDrawer(null));
    const btnNewItem = document.getElementById('btn-kb-new-item');
    if (btnNewItem) btnNewItem.addEventListener('click', () => openKBDrawer(null));
    document.getElementById('btn-kb-seed-demo')?.addEventListener('click', seedKBDemo);
    document.getElementById('btn-kb-seed-demo-2')?.addEventListener('click', seedKBDemo);
    const drawer = document.getElementById('kb-drawer');
    if (drawer) {
      document.getElementById('kb-drawer-cancel')?.addEventListener('click', () => closeDrawer('kb-drawer'));
      document.getElementById('kb-drawer-save')?.addEventListener('click', saveKBItemFromDrawer);
      document.getElementById('kb-drawer-delete')?.addEventListener('click', deleteKBItemFromDrawer);
      drawer.querySelectorAll('[data-close="kb-drawer"]').forEach(b => b.addEventListener('click', () => closeDrawer('kb-drawer')));
    }
    document.getElementById('kb-link-create')?.addEventListener('click', createKBLink);
  }

  async function loadKB() {
    try {
      const { data } = await api('/api/kb');
      state.kbCategories = data.categories || [];
      state.kbItems = data.items || [];
      state.kbLinks = data.links || [];
      for (const c of state.kbCategories) {
        if (kbState.expanded[c.id] === undefined) kbState.expanded[c.id] = true;
      }
      updateKBStats();
      renderKB();
      if (state.kbView === 'graph') renderKBGraph();
      if (global.Main && global.Main.updateTabCounts) global.Main.updateTabCounts();
    } catch (e) {
      console.error('loadKB:', e);
      showNotification(`❌ 加载知识库失败: ${e.message}`, 'error', 4000);
    }
  }

  function updateKBStats() {
    const el = document.getElementById('kb-stats');
    if (el) el.textContent = `${state.kbCategories.length} 分类 / ${state.kbItems.length} 条目`;
  }

  function filterKBItems() {
    const q = (kbState.searchKeyword || '').toLowerCase();
    let items = state.kbItems;
    if (state.currentKbCategoryId) {
      items = items.filter(i => i.category_id === state.currentKbCategoryId);
    }
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
          try {
            await api(`/api/kb/items/${id}`, { method: 'DELETE' });
            showNotification('✓ 已删除', 'success');
            await loadKB();
          } catch (err) {
            showNotification(`❌ ${err.message}`, 'error');
          }
        }
      });
    });
  }

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
      if (global.Tasks) global.Tasks.autoResizeInput();
      if (global.Main) global.Main.switchTab('chat');
      showNotification(`📖 已填入条目: ${item.title}`, 'info');
    }
  }

  // ======== 知识图谱 ========
  const KB_CATEGORY_COLORS = [
    '#667eea', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'
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
      requestAnimationFrame(() => renderKBGraph());
    }
  }

  function buildCyElements() {
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

    renderKBLinkForm();
    renderKBLinkList();

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

    state.cy.on('tap', 'node', (evt) => openKBDrawer(evt.target.id()));
    state.cy.on('tap', 'edge', (evt) => {
      const id = evt.target.id();
      const link = state.kbLinks.find(l => l.id === id);
      if (!link) return;
      if (confirm(`删除关联？\n${link.label ? '【' + link.label + '】\n' : ''}${link.type}`)) {
        deleteKBLink(id);
      }
    });
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
      setTimeout(() => switchKBView('graph'), 200);
    } catch (e) {
      showNotification(`❌ ${e.message}`, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = old1 || '🎁 演示数据'; }
      if (btn2) { btn2.disabled = false; btn2.innerHTML = old2 || '🎁 一键加载演示数据'; }
    }
  }

  // 暴露到 window
  global.KB = {
    initKB,
    loadKB,
    renderKB,
    renderKBItems,
    openKBDrawer,
    saveKBItemFromDrawer,
    deleteKBItemFromDrawer,
    openKBCategoryDrawer,
    fillChatWithKBItem,
    switchKBView,
    renderKBGraph,
    createKBLink,
    deleteKBLink,
    seedKBDemo,
    loadKBState,
    saveKBState,
    updateKBStats,
    getCategoryColor,
    getCategoryById
  };
})(window);
