/* ============================================================
   pages/kb.js — 知识库：条目（搜索+分类树+详情抽屉）｜ 图谱 canvas ｜ 提示词 ｜ 导入
   ============================================================ */
import {
  api, toast, escapeHtml, fmtTime, truncate, emptyHTML, openModal,
  confirmBox, openDrawer, closeDrawer, renderMarkdown,
} from '../api.js';

const CAT_COLORS = ['#b45309', '#4d7c0f', '#5b7a8c', '#a16207', '#8c5a44', '#6b7f3f', '#96604a', '#54707a'];

let KB = { categories: [], items: [], links: [] };
let allItems = [];

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="items">知识条目</div>
      <div class="tab" data-tab="graph">知识图谱</div>
      <div class="tab" data-tab="prompts">提示词</div>
      <div class="tab" data-tab="import">导入</div>
    </div>
    <div id="tabBody"><div class="loading-line"><span class="spinner"></span> 加载中…</div></div>`;
  const body = el.querySelector('#tabBody');
  const renderTab = (tab) => {
    el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    closeDrawer();
    if (tab === 'items') renderItems(body, ctx);
    else if (tab === 'graph') renderGraph(body, ctx);
    else if (tab === 'prompts') renderPrompts(body, ctx);
    else renderImport(body, ctx);
  };
  el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => renderTab(t.dataset.tab)));

  // 监听外部跳转打开条目抽屉（来自 tasks.js「存为知识」）
  const onOpenItemFromExternal = async (e) => {
    const itemId = e?.detail;
    if (!itemId) return;
    renderTab('items');
    // 等待 renderItems 加载 KB 完成后再打开抽屉
    setTimeout(async () => {
      await loadKB();
      const item = KB.items.find((i) => i.id === itemId);
      if (item) {
        // 切换到对应分类并打开抽屉
        const tab = document.querySelector('[data-tab="items"]');
        if (tab && !tab.classList.contains('active')) tab.click();
        openItemDrawer(itemId, null, ctx);
      }
    }, 300);
  };
  window.addEventListener('open-kb-item', onOpenItemFromExternal);
  ctx.onCleanup(() => window.removeEventListener('open-kb-item', onOpenItemFromExternal));

  renderTab('items');
}

async function loadKB() {
  KB = await api.get('/api/kb');
  KB.categories = KB.categories || [];
  KB.items = KB.items || [];
  KB.links = KB.links || [];
  allItems = KB.items;
  // 暴露给 tasks.js 做「已存知识」反查
  try { window.KBCache = KB; } catch { /* noop */ }
}

function catColor(catId) {
  const idx = KB.categories.findIndex((c) => c.id === catId);
  return CAT_COLORS[(idx < 0 ? 0 : idx) % CAT_COLORS.length];
}

function countItems(catId) {
  return KB.items.filter((i) => i.category_id === catId).length;
}

function itemByTaskId(taskId) {
  return KB.items.find((i) => i.extra?.source_task_id === taskId);
}

/* ==================== 知识条目 ==================== */
async function renderItems(box, ctx) {
  box.innerHTML = '<div class="loading-line"><span class="spinner"></span> 加载知识库…</div>';
  try { await loadKB(); } catch (err) {
    box.innerHTML = emptyHTML('📚', '知识库加载失败', err.message);
    return;
  }
  let curCat = '';
  let searchQuery = '';
  let searchResults = [];
  let searchTimer = null;

  box.innerHTML = `
    <div class="kb-layout">
      <div class="kb-tree">
        <div class="flex-between mb8">
          <b style="font-size:13px">分类</b>
          <button class="btn btn-sm btn-ghost" id="catNew" title="新建根分类">＋</button>
        </div>
        <div class="kb-cat${curCat === '' ? ' active' : ''}" data-id=""><span>📖 全部条目</span><span class="kb-badge" id="cntAll"></span></div>
        <div id="catTree"></div>
      </div>
      <div class="kb-main">
        <div class="kb-toolbar flex-between mb8">
          <div class="kb-search">
            <span class="kb-search-icon">⌕</span>
            <input type="text" id="kbSearch" placeholder="搜索知识标题、内容、标签…" autocomplete="off">
            <button class="kb-search-clear" id="kbSearchClear" title="清空" style="display:none">✕</button>
          </div>
          <div class="kb-actions">
            <button class="btn btn-ghost" id="kbImport">⤒ 导入文件</button>
            <button class="btn btn-primary" id="kbNewItem">＋ 新建条目</button>
          </div>
        </div>
        <div id="itemBody"></div>
      </div>
    </div>`;

  const itemBody = box.querySelector('#itemBody');

  function renderTree() {
    box.querySelector('#cntAll').textContent = KB.items.length;
    const tree = box.querySelector('#catTree');
    const childrenOf = (pid) => KB.categories.filter((c) => (c.parent_id || '') === pid);
    const node = (c, depth) => `
      <div class="kb-cat${curCat === c.id ? ' active' : ''}" data-id="${c.id}" style="padding-left:${9 + depth * 16}px">
        <span><span class="kb-dot" style="background:${catColor(c.id)}"></span> ${escapeHtml(c.name)} <span class="kb-badge">${countItems(c.id)}</span></span>
        <span class="cat-ops">
          <button class="btn btn-sm btn-ghost" data-op="sub" title="新建子分类">＋</button>
          <button class="btn btn-sm btn-ghost" data-op="rename" title="重命名">✏️</button>
          <button class="btn btn-sm btn-ghost" data-op="del" title="删除">🗑️</button>
        </span>
      </div>
      ${childrenOf(c.id).map((ch) => node(ch, depth + 1)).join('')}`;
    tree.innerHTML = childrenOf('').map((c) => node(c, 0)).join('') || '<p class="faint" style="font-size:12px;padding:6px 9px">暂无分类</p>';

    box.querySelectorAll('.kb-cat[data-id]').forEach((el2) => {
      el2.addEventListener('click', (e) => {
        if (e.target.closest('[data-op]')) return;
        curCat = el2.dataset.id;
        searchQuery = '';
        box.querySelector('#kbSearch').value = '';
        box.querySelector('#kbSearchClear').style.display = 'none';
        renderTree();
        renderBody();
      });
      el2.querySelectorAll('[data-op]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = el2.dataset.id;
          const op = btn.dataset.op;
          if (op === 'sub') openCategoryModal(null, id, refresh);
          else if (op === 'rename') openCategoryModal(KB.categories.find((c) => c.id === id), null, refresh);
          else if (op === 'del') confirmBox('确定删除该分类吗？下属条目将变为未分类。', async () => {
            await api.del(`/api/kb/categories/${id}`);
            toast('分类已删除', 'success');
            refresh();
          });
        });
      });
    });
  }

  async function renderBody() {
    if (searchQuery) {
      itemBody.innerHTML = '<div class="loading-line"><span class="spinner"></span> 搜索中…</div>';
      try {
        searchResults = (await api.get('/api/kb/search?q=' + encodeURIComponent(searchQuery) + '&limit=20')).results || [];
      } catch (err) {
        itemBody.innerHTML = emptyHTML('🔍', '搜索失败', err.message);
        return;
      }
      if (!searchResults.length) {
        itemBody.innerHTML = emptyHTML('🔍', `未找到「${escapeHtml(searchQuery)}」相关知识`, '试试别的关键词');
        return;
      }
      const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
      itemBody.innerHTML = `<div class="kb-cards">${searchResults.map((r) => {
        const item = KB.items.find((i) => i.id === r.id) || r;
        const cat = KB.categories.find((c) => c.id === (r.category_id || item.category_id));
        return `
        <div class="kb-item-card" data-id="${r.id}">
          <div class="flex-between">
            <h4>${highlightTerms(escapeHtml(r.title || item.title), terms)}</h4>
            <span class="kb-score">${Number(r.score || 0).toFixed(1)}</span>
          </div>
          <div class="kb-breadcrumb">${escapeHtml(cat ? cat.name : '未分类')}</div>
          <div class="snippet">${highlightTerms(escapeHtml(r.snippet || ''), terms)}</div>
          <div class="kb-card-tags">${(item.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>`;
      }).join('')}</div>`;
    } else {
      const items = curCat ? KB.items.filter((i) => i.category_id === curCat) : KB.items;
      if (!items.length) {
        itemBody.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📚</div>
            <div class="empty-title">暂无条目</div>
            <div class="empty-sub">先从导入一份文档开始吧</div>
            <button class="btn btn-primary mt8" id="emptyImport">⤒ 导入文件</button>
          </div>`;
        box.querySelector('#emptyImport')?.addEventListener('click', () => openImportModal(null, refresh));
        return;
      }
      itemBody.innerHTML = `<div class="kb-cards">${items.map((item) => {
        const cat = KB.categories.find((c) => c.id === item.category_id);
        const summary = truncate((item.content || '').replace(/\n+/g, ' '), 80);
        return `
        <div class="kb-item-card" data-id="${item.id}">
          <div class="flex-between">
            <h4>${escapeHtml(item.title)}</h4>
            <button class="btn btn-sm btn-ghost kb-card-menu" data-id="${item.id}">⋮</button>
          </div>
          <div class="kb-breadcrumb">${escapeHtml(cat?.name || '未分类')} · ${fmtTime(item.updated_at || item.created_at)}</div>
          <div class="snippet">${escapeHtml(summary)}</div>
          <div class="kb-card-tags">${(item.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>`;
      }).join('')}</div>`;
    }
    itemBody.querySelectorAll('.kb-item-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.kb-card-menu')) return;
        openItemDrawer(card.dataset.id, refresh, ctx);
      });
    });
    itemBody.querySelectorAll('.kb-card-menu').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); openCardMenu(btn.dataset.id, btn, refresh, ctx); });
    });
  }

  async function doSearch(q) {
    searchQuery = q.trim();
    if (!searchQuery) { searchClear.click(); return; }
    renderBody();
  }

  function openCardMenu(itemId, anchor, done, ctx) {
    const item = KB.items.find((i) => i.id === itemId);
    if (!item) return;
    const menu = document.createElement('div');
    menu.className = 'kb-card-menu-pop';
    menu.innerHTML = `
      <div data-op="edit">✏️ 编辑</div>
      <div data-op="prompt">💾 存为提示词</div>
      <div data-op="import">⤒ 导入文件</div>
      <div data-op="del" style="color:var(--red)">🗑️ 删除</div>`;
    const rect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.style.zIndex = '2000';
    document.body.appendChild(menu);
    menu.querySelectorAll('[data-op]').forEach((el2) => {
      el2.addEventListener('click', () => {
        const op = el2.dataset.op;
        menu.remove();
        if (op === 'edit') openItemModal(item, item.category_id, done);
        else if (op === 'prompt') saveItemAsPrompt(item.id);
        else if (op === 'import') openImportModal(itemId, done);
        else if (op === 'del') confirmBox('确定删除该条目吗？关联与分块将一并删除。', async () => {
          await api.del(`/api/kb/items/${itemId}`);
          toast('条目已删除', 'success');
          done?.();
        });
      });
    });
    const close = (e) => { if (!card.contains(e.target)) menu.remove(); };
    document.addEventListener('click', close, { once: true });
  }

  async function refresh() {
    await loadKB();
    renderTree();
    renderBody();
  }

  box.querySelector('#catNew').addEventListener('click', () => openCategoryModal(null, null, refresh));
  box.querySelector('#kbNewItem').addEventListener('click', () => openItemModal(null, curCat, refresh));
  box.querySelector('#kbImport').addEventListener('click', () => openImportModal(null, refresh));
  const searchInput = box.querySelector('#kbSearch');
  const searchClear = box.querySelector('#kbSearchClear');
  searchInput.addEventListener('input', () => {
    searchClear.style.display = searchInput.value ? 'block' : 'none';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(searchInput.value), 300);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchInput.value = ''; searchClear.click(); }
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchQuery = '';
    renderTree();
    renderBody();
  });

  renderTree();
  renderBody();
}

function highlightTerms(html, terms) {
  if (!html || !terms?.length) return html;
  let out = html;
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => `<mark class="kb-mark">${m}</mark>`);
  }
  return out;
}

async function saveItemAsPrompt(itemId) {
  const item = KB.items.find((i) => i.id === itemId);
  if (!item) return;
  try {
    await api.post('/api/prompts', {
      category: '知识库',
      name: item.title,
      content: `请参考以下知识条目回答用户问题：\n\n---\n${item.content}\n---\n\n用户问题：{{问题}}`,
    });
    toast('已存为提示词', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

/** 条目详情抽屉（右侧滑出，宽 480px） */
async function openItemDrawer(itemId, refreshAll, ctx) {
  const item = KB.items.find((i) => i.id === itemId);
  if (!item) return;
  const cat = KB.categories.find((c) => c.id === item.category_id);
  const bodyEl = openDrawer(item.title, '<div class="loading-line"><span class="spinner"></span> 加载详情…</div>');

  async function renderBody() {
    await loadKB();
    const cur = KB.items.find((i) => i.id === itemId) || item;
    const related = KB.links.filter((l) => l.from_id === itemId || l.to_id === itemId);
    const suggested = related.filter((l) => l.suggested === true);
    const confirmed = related.filter((l) => !l.suggested);
    const taskId = cur.extra?.source_task_id;
    const sourceTask = taskId ? await api.get(`/api/tasks/${taskId}`).catch(() => null) : null;

    bodyEl.innerHTML = `
      <div class="kb-drawer-head">
        <div class="kb-drawer-title" id="drawerTitle">${escapeHtml(cur.title)}</div>
        <div class="kb-drawer-meta">📁 ${escapeHtml(cat?.name || '未分类')} · 更新于 ${fmtTime(cur.updated_at || cur.created_at)}</div>
        <div class="kb-tags-edit" id="tagBox">
          ${(cur.tags || []).map((t) => `<span class="tag">${escapeHtml(t)} <button data-tag="${escapeHtml(t)}" class="kb-tag-del">×</button></span>`).join('')}
          <button class="btn btn-sm btn-ghost" id="addTag">＋</button>
        </div>
      </div>
      <div class="kb-drawer-content">
        ${renderMarkdown(cur.content || '（无内容）')}
      </div>
      <div class="kb-drawer-section">
        <div class="flex-between mb8">
          <div class="card-title" style="margin:0">🔗 关联知识（${confirmed.length}）</div>
          <button class="btn btn-sm" id="linkNew">＋ 添加关联</button>
        </div>
        ${confirmed.length ? confirmed.map((l) => linkRow(l, itemId)).join('') : '<p class="faint" style="font-size:12px">暂无已确认关联</p>'}
      </div>
      ${suggested.length ? `
      <div class="kb-drawer-section kb-suggested">
        <div class="card-title" style="margin:0">🤖 AI 建议关联（${suggested.length}）</div>
        ${suggested.map((l) => linkRow(l, itemId, true)).join('')}
      </div>` : ''}
      ${sourceTask ? `
      <div class="kb-drawer-section">
        <div class="card-title" style="margin:0">📋 来源任务</div>
        <div class="kb-source-task" data-task="${escapeHtml(taskId)}">
          <div class="kb-source-title">${escapeHtml(sourceTask.data?.content || '（无内容）')}</div>
          <div class="faint" style="font-size:11px">状态：${escapeHtml(sourceTask.status)} · 完成于 ${fmtTime(sourceTask.completed_at)}</div>
        </div>
      </div>` : ''}
      <div class="kb-drawer-actions">
        <button class="btn btn-ghost" id="drawerImport">⤒ 导入文件</button>
        <button class="btn" id="drawerEdit">编辑</button>
        <button class="btn btn-danger" id="drawerDel">删除</button>
      </div>`;

    bodyEl.querySelector('#drawerTitle').addEventListener('click', () => renameItem(cur, refreshAll));
    bodyEl.querySelector('#addTag').addEventListener('click', () => addTag(cur, refreshAll));
    bodyEl.querySelectorAll('.kb-tag-del').forEach((b) => {
      b.addEventListener('click', () => removeTag(cur, b.dataset.tag, refreshAll));
    });
    bodyEl.querySelector('#linkNew').addEventListener('click', () => addLink(cur, refreshAll));
    bodyEl.querySelectorAll('[data-link-op]').forEach((b) => {
      b.addEventListener('click', () => handleLinkOp(b.dataset.linkId, b.dataset.op, refreshAll));
    });
    bodyEl.querySelector('#drawerEdit').addEventListener('click', () => openItemModal(cur, cur.category_id, refreshAll));
    bodyEl.querySelector('#drawerImport').addEventListener('click', () => openImportModal(cur.id, refreshAll));
    bodyEl.querySelector('#drawerDel').addEventListener('click', () => {
      confirmBox(`确定删除条目「${cur.title}」吗？关联与分块将一并删除。`, async () => {
        await api.del(`/api/kb/items/${cur.id}`);
        toast('条目已删除', 'success');
        closeDrawer();
        refreshAll?.();
      });
    });
    bodyEl.querySelectorAll('.kb-source-task').forEach((el2) => {
      el2.addEventListener('click', () => {
        window.location.hash = 'tasks';
        // 等待 tasks 页渲染后通过全局事件打开详情（简单跳转）
        window.dispatchEvent(new CustomEvent('open-task-detail', { detail: el2.dataset.task }));
      });
    });
  }

  function linkRow(l, baseId, suggested = false) {
    const otherId = l.from_id === baseId ? l.to_id : l.from_id;
    const other = KB.items.find((i) => i.id === otherId);
    const dir = l.from_id === baseId ? '→' : '←';
    return `
      <div class="kb-link-row${suggested ? ' kb-link-suggested' : ''}">
        <div><span class="kb-link-dir">${dir}</span> ${escapeHtml(other?.title || otherId)} ${l.label ? `<span class="badge">${escapeHtml(l.label)}</span>` : ''}</div>
        <div class="row-actions">
          ${suggested ? `
            <button class="btn btn-sm btn-primary" data-link-id="${l.id}" data-op="confirm">确认</button>
            <button class="btn btn-sm btn-ghost" data-link-id="${l.id}" data-op="ignore">忽略</button>` : `
            <button class="btn btn-sm btn-ghost" data-link-id="${l.id}" data-op="del">解除</button>`}
        </div>
      </div>`;
  }

  async function handleLinkOp(linkId, op, done) {
    try {
      if (op === 'confirm') {
        await api.patch(`/api/kb/links/${linkId}`, { suggested: false });
        toast('关联已确认', 'success');
      } else if (op === 'ignore' || op === 'del') {
        await api.del(`/api/kb/links/${linkId}`);
        toast('关联已删除', 'success');
      }
      await loadKB();
      await renderBody();
      done?.();
    } catch (err) { toast(err.message, 'error'); }
  }

  renderBody();
}

async function addLink(item, done) {
  const others = KB.items.filter((i) => i.id !== item.id);
  if (!others.length) { toast('没有其他条目可关联', 'error'); return; }
  openModal({
    title: '添加关联条目',
    body: `
      <label class="field"><span>目标条目</span>
        <select id="lkTo">${others.map((i) => `<option value="${i.id}">${escapeHtml(i.title)}</option>`).join('')}</select></label>
      <label class="field"><span>关系标签</span>
        <input type="text" id="lkLabel" placeholder="如 参考 / 依赖"></label>`,
    okText: '添 加',
    onOk: async (modal) => {
      await api.post('/api/kb/links', {
        from_id: item.id,
        to_id: modal.querySelector('#lkTo').value,
        label: modal.querySelector('#lkLabel').value.trim() || undefined,
      });
      toast('关联已添加', 'success');
      done?.();
    },
  });
}

function renameItem(item, done) {
  openModal({
    title: '重命名条目',
    body: `<label class="field"><span>标题</span><input type="text" id="newTitle" value="${escapeHtml(item.title)}"></label>`,
    okText: '保 存',
    onOk: async (modal) => {
      const title = modal.querySelector('#newTitle').value.trim();
      if (!title) { toast('标题不能为空', 'error'); return false; }
      await api.patch(`/api/kb/items/${item.id}`, { title });
      toast('已保存', 'success');
      done?.();
    },
  });
}

function addTag(item, done) {
  openModal({
    title: '添加标签',
    body: `<label class="field"><span>标签</span><input type="text" id="newTag" placeholder="输入标签后回车或保存"></label>`,
    okText: '添 加',
    onOk: async (modal) => {
      const tag = modal.querySelector('#newTag').value.trim();
      if (!tag) { toast('标签不能为空', 'error'); return false; }
      const tags = [...new Set([...(item.tags || []), tag])];
      await api.patch(`/api/kb/items/${item.id}`, { tags });
      toast('标签已添加', 'success');
      done?.();
    },
  });
}

async function removeTag(item, tag, done) {
  const tags = (item.tags || []).filter((t) => t !== tag);
  await api.patch(`/api/kb/items/${item.id}`, { tags });
  toast('标签已移除', 'success');
  done?.();
}

function openCategoryModal(cat, parentId, done) {
  const isEdit = !!cat;
  openModal({
    title: isEdit ? '重命名分类' : parentId ? '新建子分类' : '新建根分类',
    body: `<label class="field"><span>分类名称 *</span><input type="text" id="cName" value="${escapeHtml(cat?.name || '')}"></label>`,
    okText: isEdit ? '保 存' : '创 建',
    onOk: async (modal) => {
      const name = modal.querySelector('#cName').value.trim();
      if (!name) { toast('请填写名称', 'error'); return false; }
      if (isEdit) await api.patch(`/api/kb/categories/${cat.id}`, { name });
      else await api.post('/api/kb/categories', parentId ? { name, parent_id: parentId } : { name });
      toast(isEdit ? '已保存' : '分类已创建', 'success');
      done?.();
    },
  });
}

function openItemModal(item, defaultCat, done) {
  const isEdit = !!item;
  openModal({
    title: isEdit ? '编辑条目' : '新建条目',
    wide: true,
    body: `
      <label class="field"><span>标题 *</span><input type="text" id="iTitle" value="${escapeHtml(item?.title || '')}"></label>
      <div class="form-row">
        <label class="field"><span>所属分类</span>
          <select id="iCat">
            ${KB.categories.map((c) => `<option value="${c.id}" ${(item?.category_id || defaultCat) === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('') || '<option value="">（请先在左侧创建分类）</option>'}
          </select></label>
        <label class="field"><span>标签（逗号分隔）</span>
          <input type="text" id="iTags" value="${escapeHtml((item?.tags || []).join(', '))}"></label>
      </div>
      <label class="field"><span>内容</span><textarea id="iContent" style="min-height:160px">${escapeHtml(item?.content || '')}</textarea></label>`,
    okText: isEdit ? '保 存' : '创 建',
    onOk: async (modal) => {
      const title = modal.querySelector('#iTitle').value.trim();
      const category_id = modal.querySelector('#iCat').value;
      if (!title) { toast('请填写标题', 'error'); return false; }
      if (!category_id) { toast('请先创建分类', 'error'); return false; }
      const body = {
        title,
        category_id,
        content: modal.querySelector('#iContent').value,
        tags: modal.querySelector('#iTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      };
      if (isEdit) await api.patch(`/api/kb/items/${item.id}`, body);
      else await api.post('/api/kb/items', body);
      toast(isEdit ? '已保存' : '条目已创建', 'success');
      done?.();
    },
  });
}

function openImportModal(itemId, done) {
  const items = itemId ? [] : KB.items.slice();
  openModal({
    title: '导入文件到知识库',
    wide: true,
    body: `
      ${!itemId ? `<label class="field"><span>目标条目（覆盖其内容）</span>
        <select id="imItem">${items.map((i) => `<option value="${i.id}">${escapeHtml(i.title)}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span>处理方式</span>
        <select id="imMode">
          <option value="overwrite">覆盖原内容</option>
          <option value="append">追加到末尾</option>
        </select></label>
      <div class="kb-dropzone" id="imDropzone">
        <div class="kb-dropzone-text">拖入 .md / .txt / .html 文件，或点击选择</div>
        <input type="file" id="imFile" accept=".md,.txt,.html,.htm" style="display:none">
      </div>
      <div id="imFileName" class="faint mt8"></div>`,
    okText: '开始导入',
    onOk: async (modal) => {
      const targetId = itemId || modal.querySelector('#imItem')?.value;
      const mode = modal.querySelector('#imMode').value;
      const fileInput = modal.querySelector('#imFile');
      if (!fileInput.files?.length) { toast('请选择文件', 'error'); return false; }
      const file = fileInput.files[0];
      const base64 = await readFileAsBase64(file);
      const r = await api.post(`/api/kb/items/${targetId}/import-file`, { file: { name: file.name, content_base64: base64 }, mode });
      toast(`导入成功：${r.chars} 字符`, 'success');
      done?.();
    },
  });
  const dropzone = document.querySelector('#imDropzone');
  const fileInput = document.querySelector('#imFile');
  const fileName = document.querySelector('#imFileName');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) { fileInput.files = e.dataTransfer.files; fileName.textContent = f.name; }
  });
  fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) fileName.textContent = fileInput.files[0].name; });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/* ==================== 知识图谱 ==================== */
async function renderGraph(box, ctx) {
  box.innerHTML = '<div class="loading-line"><span class="spinner"></span> 加载图谱…</div>';
  try { await loadKB(); } catch (err) {
    box.innerHTML = emptyHTML('🕸️', '图谱加载失败', err.message);
    return;
  }
  if (!KB.items.length) {
    box.innerHTML = emptyHTML('🕸️', '暂无知识条目，无法绘制图谱', '先到「知识条目」页签创建一些条目吧');
    return;
  }
  box.innerHTML = `
    <div class="card" style="position:relative">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">🕸️ 知识图谱
          <span class="sub">圆形布局 · 节点按分类着色 · 可拖拽 · 可缩放</span></div>
        <button class="btn btn-sm" id="graphReset">⟲ 重置布局</button>
      </div>
      <canvas id="graphCanvas" class="chart-canvas" style="cursor:grab"></canvas>
      <div class="kb-graph-legend">
        <div class="kb-legend-item"><span class="kb-legend-line solid"></span> 人工确认</div>
        <div class="kb-legend-item"><span class="kb-legend-line dashed"></span> AI 建议</div>
      </div>
      <div class="mt8">${KB.categories.map((c) => `<span class="badge" style="border-color:${catColor(c.id)}55"><span class="dot" style="background:${catColor(c.id)}"></span>${escapeHtml(c.name)}</span>`).join(' ')}</div>
    </div>`;

  const canvas = box.querySelector('#graphCanvas');
  const g = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.parentElement.clientWidth - 40 || 800;
  const cssH = 520;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = `${cssH}px`;

  const nodes = KB.items.map((item, i) => {
    const angle = (2 * Math.PI * i) / KB.items.length - Math.PI / 2;
    const r = Math.min(cssW, cssH) / 2 - 90;
    return {
      item,
      x: cssW / 2 + r * Math.cos(angle),
      y: cssH / 2 + r * Math.sin(angle),
      r: 16,
      color: catColor(item.category_id),
    };
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.item.id, n]));
  const edges = KB.links.filter((l) => byId[l.from_id] && byId[l.to_id]).map((l) => ({ ...l, dashed: l.suggested === true }));

  let scale = 1, offX = 0, offY = 0;
  let dragNode = null, panning = false, panStart = null, moved = false;
  let focusedNode = null;

  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    g.save();
    g.translate(offX, offY);
    g.scale(scale, scale);

    const adjacent = new Set();
    if (focusedNode) {
      adjacent.add(focusedNode.item.id);
      edges.forEach((e) => {
        if (e.from_id === focusedNode.item.id) adjacent.add(e.to_id);
        if (e.to_id === focusedNode.item.id) adjacent.add(e.from_id);
      });
    }

    // 边
    edges.forEach((e) => {
      const a = byId[e.from_id], b = byId[e.to_id];
      const dim = focusedNode && !adjacent.has(e.from_id) && !adjacent.has(e.to_id);
      g.strokeStyle = e.dashed ? '#c0b8a8' : '#cfc6b8';
      g.lineWidth = e.dashed ? 1.2 : 1.8;
      g.globalAlpha = dim ? 0.15 : 1;
      if (e.dashed) g.setLineDash([6, 4]);
      else g.setLineDash([]);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.setLineDash([]);
      // 箭头
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const ex = b.x - Math.cos(ang) * (b.r + 2), ey = b.y - Math.sin(ang) * (b.r + 2);
      g.fillStyle = e.dashed ? '#c0b8a8' : '#cfc6b8';
      g.beginPath();
      g.moveTo(ex, ey);
      g.lineTo(ex - 7 * Math.cos(ang - 0.45), ey - 7 * Math.sin(ang - 0.45));
      g.lineTo(ex - 7 * Math.cos(ang + 0.45), ey - 7 * Math.sin(ang + 0.45));
      g.fill();
      if (e.dashed) {
        g.fillStyle = '#a8a090';
        g.font = '10px sans-serif';
        g.textAlign = 'center';
        g.fillText('AI', (a.x + b.x) / 2 + 8, (a.y + b.y) / 2 - 4);
      }
      if (e.label) {
        g.fillStyle = '#8c8478';
        g.font = '10px sans-serif';
        g.textAlign = 'center';
        g.fillText(e.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 4);
      }
    });

    // 节点
    nodes.forEach((n) => {
      const dim = focusedNode && !adjacent.has(n.item.id);
      g.globalAlpha = dim ? 0.3 : 1;
      g.beginPath();
      g.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
      g.fillStyle = n.color;
      g.fill();
      g.strokeStyle = focusedNode?.item.id === n.item.id ? '#4a4540' : '#fffefb';
      g.lineWidth = focusedNode?.item.id === n.item.id ? 3 : 2;
      g.stroke();
      g.fillStyle = '#4a4540';
      g.font = '12px sans-serif';
      g.textAlign = 'center';
      const title = n.item.title.length > 8 ? `${n.item.title.slice(0, 8)}…` : n.item.title;
      g.fillText(title, n.x, n.y + n.r + 14);
    });
    g.restore();
  }

  const toWorld = (mx, my) => ({ x: (mx - offX) / scale, y: (my - offY) / scale });
  const nodeAt = (wx, wy) => nodes.find((n) => (n.x - wx) ** 2 + (n.y - wy) ** 2 <= (n.r + 4) ** 2);
  const mousePos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener('mousedown', (e) => {
    const m = mousePos(e);
    const w = toWorld(m.x, m.y);
    dragNode = nodeAt(w.x, w.y);
    moved = false;
    if (!dragNode) { panning = true; panStart = { mx: m.x, my: m.y, offX, offY }; }
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('mousemove', (e) => {
    const m = mousePos(e);
    if (dragNode) {
      const w = toWorld(m.x, m.y);
      dragNode.x = w.x;
      dragNode.y = w.y;
      moved = true;
      draw();
    } else if (panning) {
      offX = panStart.offX + (m.x - panStart.mx);
      offY = panStart.offY + (m.y - panStart.my);
      moved = true;
      draw();
    } else {
      const w = toWorld(m.x, m.y);
      canvas.style.cursor = nodeAt(w.x, w.y) ? 'pointer' : 'grab';
    }
  });
  canvas.addEventListener('mouseup', (e) => {
    canvas.style.cursor = 'grab';
    if (dragNode && !moved) {
      if (focusedNode?.item.id === dragNode.item.id) focusedNode = null;
      else focusedNode = dragNode;
      draw();
    }
    dragNode = null;
    panning = false;
  });
  canvas.addEventListener('mouseleave', () => { dragNode = null; panning = false; canvas.style.cursor = 'grab'; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const m = mousePos(e);
    const w = toWorld(m.x, m.y);
    scale = Math.min(3, Math.max(0.4, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    offX = m.x - w.x * scale;
    offY = m.y - w.y * scale;
    draw();
  }, { passive: false });

  box.querySelector('#graphReset').addEventListener('click', () => {
    scale = 1; offX = 0; offY = 0; focusedNode = null;
    const r = Math.min(cssW, cssH) / 2 - 90;
    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      n.x = cssW / 2 + r * Math.cos(angle);
      n.y = cssH / 2 + r * Math.sin(angle);
    });
    draw();
  });

  draw();
  ctx.onCleanup(() => closeDrawer());
}

/* ==================== 导入页 ==================== */
function renderImport(box, ctx) {
  box.innerHTML = `
    <div class="card">
      <div class="card-title" style="margin-bottom:16px">📥 导入知识</div>
      <div class="kb-import-steps">
        <div class="kb-import-step">
          <div class="kb-step-num">1</div>
          <div class="kb-step-body">
            <div class="kb-step-title">选择目标分类</div>
            <p class="faint" style="font-size:12px">导入前请先创建分类，系统会在此分类下新建条目。</p>
            <div id="imStepCat"><span class="faint">加载分类中…</span></div>
          </div>
        </div>
        <div class="kb-import-step">
          <div class="kb-step-num">2</div>
          <div class="kb-step-body">
            <div class="kb-step-title">拖入或选择文件</div>
            <p class="faint" style="font-size:12px">支持 .md / .txt / .html，可一次选择多个文件。</p>
            <div class="kb-dropzone" id="bulkDropzone">
              <div class="kb-dropzone-text">拖入文件到此处，或点击选择</div>
              <input type="file" id="bulkFile" accept=".md,.txt,.html,.htm" multiple style="display:none">
            </div>
          </div>
        </div>
        <div class="kb-import-step">
          <div class="kb-step-num">3</div>
          <div class="kb-step-body">
            <div class="kb-step-title">开始导入</div>
            <p class="faint" style="font-size:12px">系统会自动解析文本、分块索引并生成摘要。</p>
            <button class="btn btn-primary" id="bulkStart" disabled>开始导入</button>
          </div>
        </div>
      </div>
      <div id="bulkProgress" class="kb-progress-list"></div>
      <p class="faint mt16" style="font-size:12px">URL 导入与 Wiki 同步为规划功能，敬请期待。</p>
    </div>`;

  let selectedCategory = '';
  let selectedFiles = [];
  const catBox = box.querySelector('#imStepCat');
  const dropzone = box.querySelector('#bulkDropzone');
  const fileInput = box.querySelector('#bulkFile');
  const startBtn = box.querySelector('#bulkStart');
  const progressBox = box.querySelector('#bulkProgress');

  api.get('/api/kb/categories').then((cats) => {
    if (!cats?.length) {
      catBox.innerHTML = '<span class="faint">暂无分类，请先到「知识条目」页签创建分类</span>';
      return;
    }
    catBox.innerHTML = `<select id="bulkCat" class="field"><option value="">请选择分类</option>${cats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select>`;
    const sel = catBox.querySelector('#bulkCat');
    sel.addEventListener('change', () => {
      selectedCategory = sel.value;
      startBtn.disabled = !(selectedCategory && selectedFiles.length);
    });
  }).catch((err) => { catBox.innerHTML = `<span class="faint">分类加载失败：${escapeHtml(err.message)}</span>`; });

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    selectedFiles = Array.from(e.dataTransfer.files).filter((f) => /\.(md|txt|html|htm)$/i.test(f.name));
    updateDropzoneText();
    startBtn.disabled = !(selectedCategory && selectedFiles.length);
  });
  fileInput.addEventListener('change', () => {
    selectedFiles = Array.from(fileInput.files).filter((f) => /\.(md|txt|html|htm)$/i.test(f.name));
    updateDropzoneText();
    startBtn.disabled = !(selectedCategory && selectedFiles.length);
  });

  function updateDropzoneText() {
    const dz = dropzone.querySelector('.kb-dropzone-text');
    dz.textContent = selectedFiles.length
      ? `已选择 ${selectedFiles.length} 个文件：${selectedFiles.map((f) => f.name).join(', ')}`
      : '拖入文件到此处，或点击选择';
  }

  startBtn.addEventListener('click', async () => {
    if (!selectedCategory || !selectedFiles.length) return;
    startBtn.disabled = true;
    progressBox.innerHTML = '';
    const items = [];
    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const rowId = `bpr-${i}`;
      progressBox.insertAdjacentHTML('beforeend', `<div class="kb-progress-row" id="${rowId}"><span class="kb-progress-status parsing"></span> ${escapeHtml(file.name)} — <span class="kb-progress-text">解析中…</span></div>`);
      try {
        const base64 = await readFileAsBase64(file);
        const title = file.name.replace(/\.(md|txt|html|htm)$/i, '');
        const item = await api.post('/api/kb/items', { category_id: selectedCategory, title, content: '' });
        await api.post(`/api/kb/items/${item.id}/import-file`, { file: { name: file.name, content_base64: base64 }, mode: 'overwrite' });
        document.querySelector(`#${rowId} .kb-progress-status`).className = 'kb-progress-status done';
        document.querySelector(`#${rowId} .kb-progress-text`).textContent = '完成';
        items.push(item);
      } catch (err) {
        document.querySelector(`#${rowId} .kb-progress-status`).className = 'kb-progress-status fail';
        document.querySelector(`#${rowId} .kb-progress-text`).textContent = `失败：${err.message}`;
      }
    }
    if (items.length) toast(`成功导入 ${items.length} 个条目`, 'success');
    selectedFiles = [];
    updateDropzoneText();
    fileInput.value = '';
    startBtn.disabled = true;
  });
}

/* ==================== 提示词页签 ==================== */
async function renderPrompts(box) {
  box.innerHTML = '<div class="loading-line"><span class="spinner"></span> 加载提示词…</div>';
  let prompts;
  try { prompts = await api.get('/api/prompts'); }
  catch (err) { box.innerHTML = emptyHTML('📝', '提示词加载失败', err.message); return; }
  prompts = Array.isArray(prompts) ? prompts : [];

  box.innerHTML = `
    <div class="card">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">📝 提示词模板 <span class="sub">从知识条目快速生成</span></div>
        <button class="btn btn-sm btn-green" id="promptNew">＋ 新建</button>
      </div>
      <div id="promptList"></div>
    </div>`;

  function renderList() {
    const list = box.querySelector('#promptList');
    if (!prompts.length) { list.innerHTML = emptyHTML('📝', '暂无提示词模板'); return; }
    list.innerHTML = `<div class="kb-prompt-list">${prompts.map((p) => `
      <div class="kb-prompt-card" data-id="${p.id}">
        <div class="flex-between">
          <h4>${escapeHtml(p.name)} <span class="badge">${escapeHtml(p.category || '未分类')}</span></h4>
          <button class="btn btn-sm btn-ghost prompt-menu" data-id="${p.id}">⋮</button>
        </div>
        <div class="snippet">${escapeHtml(p.content?.slice(0, 80) || '')}</div>
        ${p.variables?.length ? `<div class="mt4"><span class="faint" style="font-size:11px">变量：</span>${p.variables.map((v) => `<span class="prompt-var">{{${escapeHtml(v)}}}</span>`).join(' ')}</div>` : ''}
      </div>`).join('')}</div>`;

    list.querySelectorAll('.kb-prompt-card').forEach((card) => {
      card.addEventListener('click', () => openPromptModal(prompts.find((p) => p.id === card.dataset.id)));
    });
    list.querySelectorAll('.prompt-menu').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = prompts.find((x) => x.id === btn.dataset.id);
        confirmBox(`确定删除提示词「${p.name}」吗？`, async () => {
          await api.del(`/api/prompts/${p.id}`);
          toast('已删除', 'success');
          prompts = prompts.filter((x) => x.id !== p.id);
          renderList();
        });
      });
    });
  }

  function openPromptModal(p) {
    const isEdit = !!p;
    openModal({
      title: isEdit ? '编辑提示词' : '新建提示词',
      wide: true,
      body: `
        <label class="field"><span>名称 *</span><input type="text" id="pName" value="${escapeHtml(p?.name || '')}"></label>
        <div class="form-row">
          <label class="field"><span>分类</span><input type="text" id="pCat" value="${escapeHtml(p?.category || '')}" placeholder="如 知识库"></label>
          <label class="field"><span>变量（逗号分隔）</span><input type="text" id="pVars" value="${escapeHtml((p?.variables || []).join(', '))}" placeholder="如 问题,背景"></label>
        </div>
        <label class="field"><span>内容 *</span><textarea id="pContent" style="min-height:160px">${escapeHtml(p?.content || '')}</textarea></label>`,
      okText: isEdit ? '保 存' : '创 建',
      onOk: async (modal) => {
        const name = modal.querySelector('#pName').value.trim();
        const content = modal.querySelector('#pContent').value;
        if (!name || !content) { toast('请填写名称和内容', 'error'); return false; }
        const body = {
          name,
          content,
          category: modal.querySelector('#pCat').value.trim(),
          variables: modal.querySelector('#pVars').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        };
        if (isEdit) {
          await api.patch(`/api/prompts/${p.id}`, body);
          Object.assign(p, body);
        } else {
          const created = await api.post('/api/prompts', body);
          prompts.push(created);
        }
        toast(isEdit ? '已保存' : '提示词已创建', 'success');
        renderList();
      },
    });
  }

  box.querySelector('#promptNew').addEventListener('click', () => openPromptModal());
  renderList();
}
