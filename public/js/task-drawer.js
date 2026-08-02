/* ============================================================
   task-drawer.js — 任务详情抽屉公共模块（chat + tasks 共用）
   展示任务全貌：状态 / 内容 / 执行信息 / result+artifacts /
   evidence / 时间线 / 子任务 / 操作（重试·改派·取消）
   ============================================================ */
import {
  api, toast, escapeHtml, fmtTime, fmtDuration, truncate, emptyHTML,
  jsonHighlight, openModal, confirmBox, openDrawer, statusBadge, SOURCE_MAP, renderMarkdown,
} from './api.js';
import { mountArtifactCards } from './artifact-cards.js';

let agentsCache = [];

/**
 * 打开任务详情抽屉
 * @param {string} taskId
 * @param {object} opts - { agents: [], onRefresh: () => {} }
 */
export async function openTaskDrawer(taskId, opts = {}) {
  agentsCache = opts.agents || agentsCache;
  const onRefresh = opts.onRefresh || (() => {});
  const bodyEl = openDrawer('任务详情', '<div class="loading-line"><span class="spinner"></span> 加载详情…</div>');

  let task;
  try {
    task = await api.get(`/api/tasks/${taskId}`);
  } catch (err) {
    bodyEl.innerHTML = emptyHTML('⚠️', '详情加载失败', err.message);
    return;
  }
  const src = SOURCE_MAP[task.source] || { text: task.source, icon: '❔' };
  const agent = agentsCache.find((a) => a.id === (task.assigned_to || task.target_agent));
  const isRunning = task.status === 'processing' || task.status === 'pending';
  const artifacts = task.result?.artifacts;

  bodyEl.innerHTML = `
    <div class="mb16">
      <div class="flex mb8">${statusBadge(task.status)} <span class="badge">${src.icon} ${src.text}</span>
        <span class="badge">优先级 ${escapeHtml(task.priority || 'normal')}</span>
        <span class="badge">类型 ${escapeHtml(task.type || '-')}</span></div>
      <p class="muted" style="font-size:12px">ID：<span class="mono">${escapeHtml(task.id)}</span></p>
    </div>
    <div class="card" style="box-shadow:none">
      <div class="card-title">📝 任务内容</div>
      <p style="white-space:pre-wrap;word-break:break-word">${escapeHtml(task.data?.content || '（无内容）')}</p>
      ${task.data?.from_user ? `<p class="muted mt8" style="font-size:12px">来自用户：${escapeHtml(task.data.from_user)}</p>` : ''}
    </div>
    <div class="card" style="box-shadow:none">
      <div class="card-title">⏱️ 执行信息</div>
      <table class="table"><tbody>
        <tr><td class="muted" style="width:110px">目标智能体</td><td>${agentName(task.target_agent)}</td></tr>
        <tr><td class="muted">实际执行者</td><td>${task.assigned_to ? agentName(task.assigned_to) : '-'}</td></tr>
        <tr><td class="muted">能力要求</td><td>${task.required_capability ? `<span class="tag">${escapeHtml(task.required_capability)}</span>` : '-'}</td></tr>
        <tr><td class="muted">创建时间</td><td class="mono">${fmtTime(task.created_at, true)}</td></tr>
        <tr><td class="muted">开始时间</td><td class="mono">${fmtTime(task.started_at, true)}</td></tr>
        <tr><td class="muted">完成时间</td><td class="mono">${fmtTime(task.completed_at, true)}</td></tr>
        <tr><td class="muted">总耗时</td><td class="mono">${fmtDuration(task.started_at, task.completed_at)}</td></tr>
      </tbody></table>
    </div>
    ${task.result?.summary ? `
    <div class="card" style="box-shadow:none">
      <div class="card-title">💬 结果摘要</div>
      <div class="md-body">${renderMarkdown(String(task.result.summary))}</div>
    </div>` : ''}
    ${artifacts && artifacts.length ? `
    <div class="card" style="box-shadow:none">
      <div class="card-title">📦 成果（${artifacts.length}）</div>
      <div id="artifactsBox"></div>
    </div>` : ''}
    <div class="card" style="box-shadow:none">
      <div class="card-title">📦 执行结果（result + evidence）</div>
      ${task.result
        ? `<pre class="json-view">${jsonHighlight(task.result)}</pre>`
        : '<p class="faint">尚无结果（任务未完成）</p>'}
    </div>
    ${renderEvidenceSearches(task.result?.evidence || task.evidence)}
    <div class="card" style="box-shadow:none">
      <div class="card-title">⏱️ 状态时间线</div>
      <div class="timeline">${renderTimeline(task)}</div>
    </div>
    <div class="card" style="box-shadow:none">
      <div class="card-title">🌳 子任务树</div>
      <div id="childTree">${renderChildren(task.children || [], 0)}</div>
    </div>
    <div class="row-actions">
      <button class="btn btn-sm" id="dRetry">重试</button>
      <button class="btn btn-sm" id="dReassign">改派</button>
      <button class="btn btn-sm btn-danger" id="dCancel">取消（删除）</button>
    </div>`;

  // 渲染 artifacts 卡片
  if (artifacts && artifacts.length) {
    const artBox = bodyEl.querySelector('#artifactsBox');
    if (artBox) mountArtifactCards(artBox, artifacts);
  }

  // 子任务跳转
  bodyEl.querySelectorAll('.child-link').forEach((a) => {
    a.addEventListener('click', () => openTaskDrawer(a.dataset.id, { agents: agentsCache, onRefresh }));
  });
  // 重试
  bodyEl.querySelector('#dRetry').addEventListener('click', async () => {
    try { await api.post(`/api/tasks/${taskId}/retry`); toast('已重试', 'success'); onRefresh(); }
    catch (err) { toast(err.message, 'error'); }
  });
  // 改派
  bodyEl.querySelector('#dReassign').addEventListener('click', () => openReassign(taskId, () => onRefresh()));
  // 取消
  bodyEl.querySelector('#dCancel').addEventListener('click', () => {
    confirmBox('确定取消（删除）该任务吗？', async () => {
      try { await api.del(`/api/tasks/${taskId}`); toast('已删除', 'success'); onRefresh(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });

  function agentName(id) {
    if (!id) return '<span class="faint">自动分配</span>';
    const a = agentsCache.find((x) => x.id === id);
    return a ? escapeHtml(a.name) : `<span class="mono faint">${escapeHtml(String(id).slice(0, 14))}</span>`;
  }
  function renderChildren(children, depth) {
    if (!children.length) return depth === 0 ? '<p class="faint">无子任务</p>' : '';
    return `<div style="${depth ? `margin-left:${Math.min(depth * 18, 54)}px;border-left:2px solid var(--border);padding-left:10px` : ''}">` +
      children.map((c) => `
        <div class="flex mt8" style="gap:8px">
          ${statusBadge(c.status)}
          <a href="javascript:void 0" class="child-link" data-id="${c.id}">${escapeHtml(truncate(c.data?.content, 40))}</a>
          <span class="faint" style="font-size:11px">${agentName(c.assigned_to || c.target_agent)}</span>
        </div>
        ${c.children?.length ? renderChildren(c.children, depth + 1) : ''}`).join('') + '</div>';
  }
}

/** 状态时间线 */
function renderTimeline(t) {
  const fmt = (ts) => ts ? fmtTime(ts, true) : '—';
  const dur = (a, b) => {
    if (!a || !b) return '';
    const secs = Math.max(0, b - a);
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
    return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
  };
  const nodes = [];
  nodes.push({ dot: 'dot-blue', label: '已创建', time: fmt(t.created_at) });
  if (t.started_at) nodes.push({ dot: 'dot-yellow', label: '开始执行', time: `${fmt(t.started_at)}${t.created_at ? `（等待 ${dur(t.created_at, t.started_at)}）` : ''}` });
  if (t.completed_at) {
    const ok = t.status === 'completed';
    nodes.push({ dot: ok ? 'dot-green' : 'dot-red', label: ok ? '已完成' : '已失败', time: `${fmt(t.completed_at)}${t.started_at ? `（执行 ${dur(t.started_at, t.completed_at)}）` : ''}` });
  } else if (t.started_at) {
    nodes.push({ dot: 'dot-yellow spinner-dot', label: '执行中…', time: `已耗时 ${dur(t.started_at, Math.floor(Date.now() / 1000))}` });
  } else {
    nodes.push({ dot: 'dot-gray', label: '等待领取', time: '—' });
  }
  return nodes.map((n, i) => `
    <div class="tl-node">
      <span class="tl-dot ${n.dot}"></span>
      ${i < nodes.length - 1 ? '<span class="tl-line"></span>' : ''}
      <span class="tl-label">${n.label}</span>
      <span class="tl-time mono">${n.time}</span>
    </div>`).join('');
}

/** evidence 区顶部渲染 searches 记录 */
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

/** 改派弹窗 */
function openReassign(taskId, onRefresh) {
  const agents = agentsCache.filter((a) => a.review_status === 'active');
  openModal({
    title: '改派给其他 agent',
    body: `
      <label class="field">
        <span>选择新执行者</span>
        <select id="reassignAgent">${agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select>
      </label>`,
    okText: '改 派',
    onOk: async (modal) => {
      const newAgentId = modal.querySelector('#reassignAgent').value;
      try {
        await api.post('/api/chat/reassign', { task_id: taskId, new_agent_id: newAgentId });
        toast('已改派', 'success');
        onRefresh();
      } catch (err) { toast(err.message, 'error'); }
    },
  });
}
