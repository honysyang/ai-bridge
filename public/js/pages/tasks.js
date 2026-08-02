/* ============================================================
   pages/tasks.js — 任务中心：全部任务 / 定时任务
   ============================================================ */
import {
  api, toast, escapeHtml, fmtTime, fmtDuration, truncate, emptyHTML,
  jsonHighlight, openModal, confirmBox, openDrawer, statusBadge, SOURCE_MAP,
} from '../api.js';
import { openTaskDrawer } from '../task-drawer.js';

let agentsCache = [];

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="all">全部任务</div>
      <div class="tab" data-tab="schedules">定时任务</div>
    </div>
    <div id="tabBody"><div class="loading-line"><span class="spinner"></span> 加载中…</div></div>`;

  try { agentsCache = await api.get('/api/agents'); } catch { agentsCache = []; }

  const body = el.querySelector('#tabBody');
  const renderTab = (tab) => {
    el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'all') renderAllTasks(body, ctx);
    else renderSchedules(body, ctx);
  };
  el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => renderTab(t.dataset.tab)));
  renderTab('all');
}

function agentName(id) {
  if (!id) return '<span class="faint">自动分配</span>';
  const a = agentsCache.find((x) => x.id === id);
  return a ? escapeHtml(a.name) : `<span class="mono faint">${escapeHtml(String(id).slice(0, 14))}</span>`;
}

/* ==================== 全部任务 ==================== */
async function renderAllTasks(box, ctx) {
  box.innerHTML = `
    <div class="card">
      <div class="filter-bar">
        <label class="field"><span>状态</span>
          <select id="fStatus"><option value="">全部</option>
            <option value="pending">待分配</option><option value="processing">执行中</option>
            <option value="completed">已完成</option><option value="failed">失败</option>
          </select></label>
        <label class="field"><span>来源</span>
          <select id="fSource"><option value="">全部</option>
            ${Object.entries(SOURCE_MAP).map(([k, v]) => `<option value="${k}">${v.icon} ${v.text}</option>`).join('')}
          </select></label>
        <label class="field"><span>执行者</span>
          <select id="fAgent"><option value="">全部</option>
            ${agentsCache.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
          </select></label>
        <label class="field grow"><span>关键字（匹配任务内容）</span>
          <input type="text" id="fQ" placeholder="输入关键字回车搜索"></label>
        <button class="btn btn-primary" id="fSearch">筛 选</button>
        <button class="btn" id="fRefresh">⟳ 刷新</button>
        <button class="btn btn-green" id="fNew">＋ 新建任务</button>
      </div>
      <div id="statsLine" class="muted mb8" style="font-size:12px"></div>
      <div class="table-wrap" id="taskTable"><div class="loading-line"><span class="spinner"></span> 加载任务…</div></div>
    </div>`;

  const state = { tasks: [], childIds: new Set(), currentQ: '' };

  /** 在 content 文本中给命中关键字的片段包 <mark>（高亮） */
  function highlight(text, q) {
    const safe = escapeHtml(text || '');
    if (!q) return safe;
    const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(`(${qEsc})`, 'gi'), '<mark>$1</mark>');
  }

  async function load() {
    const p = new URLSearchParams();
    const st = box.querySelector('#fStatus').value;
    const so = box.querySelector('#fSource').value;
    const ag = box.querySelector('#fAgent').value;
    const q = box.querySelector('#fQ').value.trim();
    if (st) p.set('status', st);
    if (so) p.set('source', so);
    if (ag) p.set('agent', ag);
    if (q) p.set('q', q);
    p.set('limit', '200');
    state.currentQ = q;
    const table = box.querySelector('#taskTable');
    table.innerHTML = '<div class="loading-line"><span class="spinner"></span> 加载任务…</div>';
    try {
      const [tasks, stats] = await Promise.all([
        api.get(`/api/tasks?${p.toString()}`),
        api.get('/api/tasks/stats').catch(() => null),
      ]);
      state.tasks = Array.isArray(tasks) ? tasks : [];
      state.childIds = new Set(state.tasks.filter((t) => t.parent_task_id).map((t) => t.parent_task_id));
      if (stats) {
        box.querySelector('#statsLine').textContent =
          `待分配 ${stats.pending ?? 0} · 执行中 ${stats.processing ?? 0} · 已完成 ${stats.completed ?? 0} · 失败 ${stats.failed ?? 0} · 共 ${stats.total ?? 0}`;
      }
      renderTable();
    } catch (err) {
      table.innerHTML = emptyHTML('📋', '任务加载失败', err.message);
    }
  }

  function renderTable() {
    const table = box.querySelector('#taskTable');
    if (!state.tasks.length) {
      table.innerHTML = emptyHTML('📋', '暂无匹配的任务', '可调整筛选条件，或点击「新建任务」手动派发');
      return;
    }
    table.innerHTML = `<table class="table">
      <thead><tr>
        <th>内容摘要</th><th>来源</th><th>执行者</th><th>状态</th>
        <th>耗时</th><th>委派链</th><th>创建时间</th><th>操作</th>
      </tr></thead>
      <tbody>${state.tasks.map((t) => {
        const src = SOURCE_MAP[t.source] || { text: t.source, icon: '❔' };
        const chain = t.parent_task_id
          ? '<span class="badge badge-accent" title="子任务">↩ 子任务</span>'
          : (state.childIds.has(t.id) ? '<span class="badge badge-blue" title="含子任务">🌳 父任务</span>' : '<span class="faint">-</span>');
        const running = t.status === 'processing';
        return `<tr class="clickable" data-id="${t.id}">
          <td style="max-width:280px">${highlight(truncate(t.data?.content, 46), state.currentQ)}</td>
          <td title="${src.text}">${src.icon} <span class="muted">${src.text}</span></td>
          <td>${t.assigned_to ? agentName(t.assigned_to) : agentName(t.target_agent)}</td>
          <td>${statusBadge(t.status)}${running ? ' <span class="spinner"></span>' : ''}</td>
          <td class="mono">${t.status === 'pending' ? '-' : fmtDuration(t.started_at, t.completed_at)}</td>
          <td>${chain}</td>
          <td class="faint mono">${fmtTime(t.created_at)}</td>
          <td><div class="row-actions">
            <button class="btn btn-sm" data-act="retry" title="重新置为待分配">重试</button>
            <button class="btn btn-sm" data-act="reassign" title="改派执行者">改派</button>
            <button class="btn btn-sm btn-danger" data-act="cancel" title="删除该任务">取消</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody></table>`;

    table.querySelectorAll('tr.clickable').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-act]')) return;
        openTaskDetail(tr.dataset.id, ctx);
      });
      tr.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = tr.dataset.id;
          const act = btn.dataset.act;
          if (act === 'retry') {
            try { await api.post(`/api/tasks/${id}/retry`); toast('已重试，任务回到待分配', 'success'); load(); }
            catch (err) { toast(err.message, 'error'); }
          } else if (act === 'reassign') {
            openReassign(id, load);
          } else if (act === 'cancel') {
            confirmBox('确定取消（删除）该任务吗？此操作不可恢复。', async () => {
              await api.del(`/api/tasks/${id}`);
              toast('任务已取消', 'success');
              load();
            });
          }
        });
      });
    });
  }

  box.querySelector('#fSearch').addEventListener('click', load);
  box.querySelector('#fRefresh').addEventListener('click', load);
  box.querySelector('#fQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  box.querySelector('#fNew').addEventListener('click', () => openNewTask(load));
  load();

  // 10s 静默刷新
  const timer = setInterval(() => { if (box.isConnected) load(); }, 10000);
  ctx.onCleanup(() => clearInterval(timer));
}

function openReassign(taskId, done) {
  // 先取最新任务信息，确认是 pending/failed 且拿到当前 target_agent
  api.get(`/api/tasks/${taskId}`).then((task) => {
    const cur = task.target_agent || task.assigned_to;
    const curName = cur ? (agentsCache.find((a) => a.id === cur)?.name || cur.slice(0, 12)) : '自动分配';
    openModal({
      title: '改派任务执行者',
      body: `
        <p class="muted mb8" style="font-size:12px">当前执行者：<b>${escapeHtml(curName)}</b></p>
        <label class="field"><span>目标智能体（留空 = 自动分配）</span>
          <select id="raAgent">
            <option value="">自动分配</option>
            ${agentsCache.filter((a) => a.review_status === 'active').map((a) =>
              `<option value="${a.id}"${a.id === cur ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
          </select></label>`,
      okText: '改 派',
      onOk: async (modal) => {
        await api.post(`/api/tasks/${taskId}/reassign`, { target_agent: modal.querySelector('#raAgent').value || null });
        toast('已改派', 'success');
        done?.();
      },
    });
  }).catch((err) => toast(err.message, 'error'));
}

function openNewTask(done) {
  const TYPES = [
    ['query_info', '🔍 信息查询'],
    ['chat', '💬 对话'],
    ['reply_message', '↩️ 回复消息'],
    ['analyze_data', '📊 数据分析'],
    ['generate_content', '✍️ 内容生成'],
    ['execute_command', '⚡ 命令执行'],
    ['multi_step', '🔄 多步任务'],
  ];
  openModal({
    title: '新建任务',
    wide: true,
    body: `
      <label class="field"><span>任务内容 *</span>
        <textarea id="ntContent" placeholder="描述需要智能体完成的任务"></textarea></label>
      <div class="form-row">
        <label class="field"><span>任务类型</span>
          <select id="ntType">
            ${TYPES.map(([k, v]) => `<option value="${k}"${k === 'query_info' ? ' selected' : ''}>${v}</option>`).join('')}
          </select></label>
        <label class="field"><span>目标智能体</span>
          <select id="ntAgent"><option value="">自动分配</option>
            ${agentsCache.filter((a) => a.review_status === 'active').map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
          </select></label>
        <label class="field"><span>优先级</span>
          <select id="ntPriority">
            <option value="normal">普通</option>
            <option value="low">低</option>
            <option value="high">高</option>
            <option value="urgent">紧急</option>
          </select></label>
      </div>
      <label class="field"><span>能力要求（可选，填后仅具备该能力的 agent 可领取）</span>
        <input type="text" id="ntCap" placeholder="如 code / search / write"></label>`,
    okText: '创建任务',
    onOk: async (modal) => {
      const content = modal.querySelector('#ntContent').value.trim();
      if (!content) { toast('请填写任务内容', 'error'); return false; }
      const body = { type: modal.querySelector('#ntType').value, priority: modal.querySelector('#ntPriority').value, data: { content } };
      const agent = modal.querySelector('#ntAgent').value;
      const cap = modal.querySelector('#ntCap').value.trim();
      if (agent) body.target_agent = agent;
      if (cap) body.required_capability = cap;
      await api.post('/api/tasks', body);
      toast('任务已创建', 'success');
      done?.();
    },
  });
}

/** 详情抽屉：复用公共 task-drawer 模块（含 artifacts 卡片渲染） */
async function openTaskDetail(taskId, ctx) {
  await openTaskDrawer(taskId, { agents: agentsCache, onRefresh: () => ctx.refresh?.() });
}

/** 渲染「存为知识」按钮：已存则绿色态跳转，未存则赭石描边 */
function renderSaveToKbBtn(task) {
  const existing = typeof itemByTaskId === 'function' ? itemByTaskId(task.id) : null;
  if (existing) {
    return `<button class="btn btn-sm btn-green" id="dSaveKb" data-item="${escapeHtml(existing.id)}">📚 已存知识</button>`;
  }
  if (task.status !== 'completed' || !task.result) return '';
  return `<button class="btn btn-sm btn-ghost" id="dSaveKb">📥 存为知识</button>`;
}

/** 在 evidence 区顶部渲染 searches 记录 */
function renderEvidenceSearches(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';
  const searches = Array.isArray(evidence.searches) ? evidence.searches : [];
  if (!searches.length) return '';
  return `<div class="card" style="box-shadow:none;margin-top:8px">
    <div class="card-title">🔍 知识库检索留痕</div>
    ${searches.map((s) => {
      const q = typeof s === 'string' ? s : (s?.query || '');
      const hits = typeof s === 'object' && s !== null ? (s.hits ?? '?') : '?';
      return `<div class="kb-search-trace">🔍 检索了知识库：「${escapeHtml(q)}」（命中 ${hits} 条）</div>`;
    }).join('')}
  </div>`;
}

/** 在全部知识条目中查找来源任务对应的条目（兼容外部同名函数） */
function itemByTaskId(taskId) {
  try {
    // 如果 KB 全局变量来自 kb.js 页面，则复用
    if (window.KBCache?.items) {
      return window.KBCache.items.find((i) => i.extra?.source_task_id === taskId);
    }
  } catch { /* noop */ }
  return null;
}

/** 打开存为知识弹窗 */
async function openSaveToKb(task, ctx, done) {
  let cats;
  try { cats = await api.get('/api/kb/categories'); }
  catch (err) { toast(err.message, 'error'); return; }
  if (!cats?.length) { toast('请先创建知识库分类', 'error'); return; }
  const defaultTitle = (task.data?.content || '').slice(0, 20);
  openModal({
    title: '存为知识',
    body: `
      <label class="field"><span>标题</span>
        <input type="text" id="kbtTitle" value="${escapeHtml(defaultTitle)}"></label>
      <label class="field"><span>分类 *</span>
        <select id="kbtCat">${cats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>标签（逗号分隔）</span>
        <input type="text" id="kbtTags" placeholder="如 排查,命令行"></label>`,
    okText: '保 存',
    onOk: async (modal) => {
      const category_id = modal.querySelector('#kbtCat').value;
      const title = modal.querySelector('#kbtTitle').value.trim();
      const tags = modal.querySelector('#kbtTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (!category_id) { toast('请选择分类', 'error'); return false; }
      const r = await api.post('/api/kb/from-task', { task_id: task.id, category_id, title, tags });
      toast('已存为知识', 'success');
      if (r?.item?.id) {
        setTimeout(() => {
          window.location.hash = 'kb';
          window.dispatchEvent(new CustomEvent('open-kb-item', { detail: r.item.id }));
        }, 400);
      }
      done?.();
    },
  });
}

/* ==================== 定时任务 ==================== */
async function renderSchedules(box) {
  box.innerHTML = `
    <div class="card">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">⏰ 定时任务规则
          <span class="sub">调度器每 30 秒检查一次，到点自动创建「定时」来源任务</span></div>
        <button class="btn btn-green" id="scNew">＋ 新建规则</button>
      </div>
      <div class="table-wrap" id="scTable"><div class="loading-line"><span class="spinner"></span> 加载规则…</div></div>
    </div>`;

  async function load() {
    const table = box.querySelector('#scTable');
    let rules;
    try {
      rules = await api.get('/api/schedules');
    } catch (err) {
      table.innerHTML = emptyHTML('⏰', '规则加载失败', err.message);
      return;
    }
    if (!Array.isArray(rules) || !rules.length) {
      table.innerHTML = emptyHTML('⏰', '暂无定时任务规则', '点击「新建规则」创建周期性任务');
      return;
    }
    table.innerHTML = `<table class="table">
      <thead><tr>
        <th>名称</th><th>间隔（分钟）</th><th>目标智能体</th><th>下次执行</th>
        <th>上次执行</th><th>启用</th><th>操作</th>
      </tr></thead>
      <tbody>${rules.map((r) => `<tr data-id="${r.id}">
        <td>${escapeHtml(r.name)}<div class="faint" style="font-size:11px">${escapeHtml(truncate(r.content_template, 34))}</div></td>
        <td class="mono">${r.interval_minutes}</td>
        <td>${agentName(r.target_agent)}${r.required_capability ? ` <span class="tag">${escapeHtml(r.required_capability)}</span>` : ''}</td>
        <td class="mono">${r.enabled ? fmtTime(r.next_run) : '<span class="faint">已停用</span>'}</td>
        <td class="mono faint">${fmtTime(r.last_run)}</td>
        <td><label class="switch"><input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}><span class="slider"></span></label></td>
        <td><div class="row-actions">
          <button class="btn btn-sm btn-primary" data-act="runNow" title="将下次执行时间置为现在，调度器下个周期即触发">立即执行</button>
          <button class="btn btn-sm" data-act="edit">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="del">删除</button>
        </div></td>
      </tr>`).join('')}</tbody></table>`;

    table.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      const rule = rules.find((r) => r.id === id);
      tr.querySelector('[data-act="toggle"]').addEventListener('change', async (e) => {
        try {
          await api.patch(`/api/schedules/${id}`, { enabled: e.target.checked });
          toast(e.target.checked ? '已启用' : '已停用', 'success');
          load();
        } catch (err) { toast(err.message, 'error'); load(); }
      });
      tr.querySelector('[data-act="runNow"]').addEventListener('click', async () => {
        try {
          await api.patch(`/api/schedules/${id}`, { next_run: Math.floor(Date.now() / 1000) - 1, enabled: true });
          toast('已安排立即执行，将在下个调度周期（≤30 秒）触发', 'success');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
      tr.querySelector('[data-act="edit"]').addEventListener('click', () => openScheduleModal(rule, load));
      tr.querySelector('[data-act="del"]').addEventListener('click', () => {
        confirmBox(`确定删除定时规则「${rule.name}」吗？`, async () => {
          await api.del(`/api/schedules/${id}`);
          toast('规则已删除', 'success');
          load();
        });
      });
    });
  }

  box.querySelector('#scNew').addEventListener('click', () => openScheduleModal(null, load));
  load();
}

function openScheduleModal(rule, done) {
  const isEdit = !!rule;
  openModal({
    title: isEdit ? '编辑定时规则' : '新建定时规则',
    wide: true,
    body: `
      <label class="field"><span>规则名称 *</span>
        <input type="text" id="scName" value="${escapeHtml(rule?.name || '')}" placeholder="如：每小时健康检查"></label>
      <label class="field"><span>任务内容模板 *（到点后作为任务内容创建）</span>
        <textarea id="scContent" placeholder="如：请汇总当前系统状态并生成简报">${escapeHtml(rule?.content_template || '')}</textarea></label>
      <div class="form-row">
        <label class="field"><span>间隔（分钟）*</span>
          <input type="number" id="scInterval" min="1" value="${rule?.interval_minutes || 60}"></label>
        <label class="field"><span>目标智能体</span>
          <select id="scAgent"><option value="">自动分配</option>
            ${agentsCache.filter((a) => a.review_status === 'active').map((a) => `<option value="${a.id}" ${rule?.target_agent === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
          </select></label>
      </div>
      <label class="field"><span>能力要求（可选）</span>
        <input type="text" id="scCap" value="${escapeHtml(rule?.required_capability || '')}"></label>`,
    okText: isEdit ? '保 存' : '创 建',
    onOk: async (modal) => {
      const name = modal.querySelector('#scName').value.trim();
      const content = modal.querySelector('#scContent').value.trim();
      const interval = parseInt(modal.querySelector('#scInterval').value, 10);
      if (!name || !content) { toast('名称与内容模板必填', 'error'); return false; }
      if (!interval || interval < 1) { toast('间隔至少 1 分钟', 'error'); return false; }
      const body = {
        name,
        content_template: content,
        interval_minutes: interval,
        target_agent: modal.querySelector('#scAgent').value || null,
        required_capability: modal.querySelector('#scCap').value.trim() || null,
      };
      if (isEdit) await api.patch(`/api/schedules/${rule.id}`, body);
      else await api.post('/api/schedules', { ...body, enabled: true });
      toast(isEdit ? '规则已保存' : '规则已创建', 'success');
      done?.();
    },
  });
}
