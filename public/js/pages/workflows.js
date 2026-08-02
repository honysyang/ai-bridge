/* ============================================================
   pages/workflows.js — 工作流：可视化模板编排器｜执行运行图
   ============================================================ */
import {
  api, toast, escapeHtml, fmtTime, fmtDuration, emptyHTML, openModal,
  confirmBox, openDrawer, renderMarkdown, jsonHighlight, statusBadge,
} from '../api.js';
import { createWorkflowCanvas } from '../workflow-canvas.js';

const RUN_STATUS = {
  running: '<span class="badge badge-blue">运行中</span>',
  completed: '<span class="badge badge-green">已完成</span>',
  failed: '<span class="badge badge-red">失败</span>',
};

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="tpl">模板</div>
      <div class="tab" data-tab="runs">执行记录</div>
    </div>
    <div id="tabBody"><div class="loading-line"><span class="spinner"></span> 加载中…</div></div>`;
  const body = el.querySelector('#tabBody');
  const renderTab = (tab) => {
    el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'tpl') renderTemplates(body);
    else renderRuns(body, ctx);
  };
  el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => renderTab(t.dataset.tab)));
  renderTab('tpl');
}

/* ==================== 模板列表 ==================== */
async function renderTemplates(box) {
  box.innerHTML = `
    <div class="flex-between mb16">
      <p class="section-desc" style="margin:0">可视化拖拽编排多步骤协作流程，支持 {{steps[N].summary}} 数据流转。</p>
      <button class="btn btn-green" id="wfNew">＋ 新建模板</button>
    </div>
    <div id="wfGrid"><div class="loading-line"><span class="spinner"></span> 加载模板…</div></div>`;

  async function load() {
    const grid = box.querySelector('#wfGrid');
    let wfs;
    try { wfs = await api.get('/api/workflows'); } catch (err) {
      grid.innerHTML = emptyHTML('🔀', '模板加载失败', err.message);
      return;
    }
    if (!Array.isArray(wfs) || !wfs.length) {
      grid.innerHTML = emptyHTML('🔀', '暂无工作流模板', '点击「新建模板」，开始可视化编排');
      return;
    }
    grid.innerHTML = `<div class="wf-grid">${wfs.map((w) => `
      <div class="wf-card" data-id="${w.id}">
        <h4>${escapeHtml(w.name)}</h4>
        <p class="muted mb8" style="font-size:12px">${escapeHtml(w.description || '（无描述）')}</p>
        <p class="mb8" style="font-size:12px">🪜 ${w.steps?.length || 0} 个步骤 · <span class="faint">${fmtTime(w.created_at)}</span></p>
        <div class="row-actions">
          <button class="btn btn-sm btn-primary" data-op="exec">▶ 执行</button>
          <button class="btn btn-sm" data-op="edit">✏️ 编辑</button>
          <button class="btn btn-sm btn-danger" data-op="del">删除</button>
        </div>
      </div>`).join('')}</div>`;

    grid.querySelectorAll('.wf-card').forEach((card) => {
      const w = wfs.find((x) => x.id === card.dataset.id);
      card.querySelectorAll('[data-op]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const op = btn.dataset.op;
          if (op === 'exec') {
            try {
              const run = await api.post(`/api/workflows/${w.id}/execute`, { name: `${w.name} · ${new Date().toLocaleString('zh-CN')}` });
              toast(`已启动执行实例「${run.name || run.id}」`, 'success');
            } catch (err) { toast(err.message, 'error'); }
          } else if (op === 'edit') openEditor(w, load);
          else if (op === 'del') confirmBox(`确定删除模板「${w.name}」吗？历史执行记录保留。`, async () => {
            await api.del(`/api/workflows/${w.id}`);
            toast('模板已删除', 'success');
            load();
          });
        });
      });
    });
  }

  box.querySelector('#wfNew').addEventListener('click', () => openEditor(null, load));
  load();
}

/* ==================== 可视化编排器 ==================== */
function openEditor(wf, done) {
  const isEdit = !!wf;
  // 用页面级覆盖层作为编辑器容器
  const overlay = document.createElement('div');
  overlay.className = 'wf-editor-overlay';
  overlay.innerHTML = `
    <div class="wf-editor">
      <div class="wf-editor-toolbar">
        <div class="flex" style="gap:10px">
          <button class="btn btn-sm" id="wfBack">← 返回列表</button>
          <span class="wf-editor-title" id="wfTitle">${isEdit ? escapeHtml('编辑：' + wf.name) : '新建工作流模板'}</span>
        </div>
        <div class="flex" style="gap:10px">
          <button class="btn btn-sm" id="wfAddStep">＋ 添加步骤</button>
          <button class="btn btn-sm" id="wfAutoLayout">自动布局</button>
          <div class="wf-zoom-wrap">
            <button class="btn btn-sm btn-ghost" id="wfZoomOut">－</button>
            <span id="wfZoomPct">100%</span>
            <button class="btn btn-sm btn-ghost" id="wfZoomIn">＋</button>
          </div>
          <button class="btn btn-sm btn-primary" id="wfSave">保存</button>
        </div>
      </div>
      <div class="wf-editor-body">
        <div class="wf-editor-canvas" id="wfCanvasWrap"></div>
        <div class="wf-editor-panel" id="wfPanel" hidden>
          <div class="wf-panel-head">步骤属性<button class="btn btn-ghost btn-sm" id="wfPanelClose">✕</button></div>
          <div class="wf-panel-body">
            <label class="field">
              <span>步骤名称 *</span>
              <input type="text" id="pName" placeholder="如：需求分析">
            </label>
            <label class="field">
              <span>步骤内容 *</span>
              <textarea id="pContent" style="min-height:120px" placeholder="输入步骤执行内容，可引用前序结果"></textarea>
              <p class="faint" style="font-size:12px;margin-top:-8px">可插入 {{steps[N].summary}} 引用前序结果</p>
            </label>
            <div class="field" id="pVarBox" style="display:none">
              <span>可插入变量</span>
              <div class="wf-var-chips" id="pVarChips"></div>
            </div>
            <label class="field">
              <span>能力要求（可选）</span>
              <input type="text" id="pCap" placeholder="如 code">
            </label>
            <label class="field">
              <span>目标智能体（可选）</span>
              <select id="pAgent"><option value="">自动分配</option></select>
            </label>
            <div class="wf-panel-ops">
              <button class="btn btn-danger btn-sm" id="pDel">删除步骤</button>
            </div>
          </div>
        </div>
        <div class="wf-editor-panel-placeholder" id="wfPanelPlaceholder">点选画布节点编辑属性</div>
      </div>
      <div class="wf-editor-namebar">
        <input type="text" id="wfName" class="input" placeholder="模板名称 *" value="${isEdit ? escapeHtml(wf.name) : ''}">
        <input type="text" id="wfDesc" class="input" placeholder="描述" value="${isEdit ? escapeHtml(wf.description || '') : ''}">
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const canvasWrap = overlay.querySelector('#wfCanvasWrap');
  const panel = overlay.querySelector('#wfPanel');
  const placeholder = overlay.querySelector('#wfPanelPlaceholder');
  const pName = overlay.querySelector('#pName');
  const pContent = overlay.querySelector('#pContent');
  const pCap = overlay.querySelector('#pCap');
  const pAgent = overlay.querySelector('#pAgent');
  const pVarChips = overlay.querySelector('#pVarChips');
  const pVarBox = overlay.querySelector('#pVarBox');
  const zoomPct = overlay.querySelector('#wfZoomPct');
  let agents = [];

  // 加载 agent 下拉
  (async () => {
    try {
      agents = await api.get('/api/agents');
      pAgent.innerHTML = `<option value="">自动分配</option>${agents
        .filter((a) => a.review_status === 'active')
        .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.id.slice(0, 8))})</option>`)
        .join('')}`;
    } catch { /* 失败则留空 */ }
  })();

  const canvas = createWorkflowCanvas({
    el: canvasWrap,
    editable: true,
    onError: (msg) => toast(msg, 'error'),
    onChange: () => {
      // 节点位置/连线变化时不需要立即保存，但可刷新变量面板
      renderVarChips();
    },
    onSelectNode: (node, index) => {
      if (index === null) {
        panel.hidden = true;
        placeholder.hidden = false;
        return;
      }
      panel.hidden = false;
      placeholder.hidden = true;
      pName.value = node.name;
      pContent.value = node.content;
      pCap.value = node.capability || '';
      pAgent.value = node.target_agent || '';
      renderVarChips();
    },
  });

  canvas.setSteps(wf?.steps || [{ name: '步骤 1', content: '', x: 40, y: 40 }]);
  if (!wf?.steps?.length) canvas.autoLayout();

  // 变量 chips：列出所有其他步骤供引用
  function renderVarChips() {
    const steps = canvas.getSteps();
    const idx = canvas.getSelectedIndex();
    if (idx === null || steps.length <= 1) {
      pVarBox.style.display = 'none';
      return;
    }
    pVarBox.style.display = 'block';
    pVarChips.innerHTML = steps.map((s, i) => i === idx ? '' : `
      <button class="btn btn-sm btn-ghost" data-var="${i}">{{steps[${i}].summary}}：${escapeHtml(truncate(s.name, 12))}</button>`).join('');
    pVarChips.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = btn.dataset.var;
        const insert = `{{steps[${i}].summary}}`;
        const ta = pContent;
        const start = ta.selectionStart || ta.value.length;
        const end = ta.selectionEnd || ta.value.length;
        ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + insert.length;
        ta.focus();
        syncPanelToStep();
      });
    });
  }

  function syncPanelToStep() {
    const idx = canvas.getSelectedIndex();
    if (idx === null) return;
    canvas.updateStep(idx, {
      name: pName.value,
      content: pContent.value,
      capability: pCap.value,
      target_agent: pAgent.value,
    });
    overlay.querySelector('#wfTitle').textContent = overlay.querySelector('#wfName').value || (isEdit ? wf.name : '新建工作流模板');
  }

  [pName, pContent, pCap, pAgent].forEach((el) => el.addEventListener('input', syncPanelToStep));

  overlay.querySelector('#wfPanelClose').addEventListener('click', () => canvas.clearSelection());

  overlay.querySelector('#wfAddStep').addEventListener('click', () => {
    const steps = canvas.getSteps();
    canvas.addStep({ name: `步骤 ${steps.length + 1}`, content: '', x: 40 + steps.length * 20, y: 40 + steps.length * 20 });
  });

  overlay.querySelector('#wfAutoLayout').addEventListener('click', () => canvas.autoLayout());

  overlay.querySelector('#pDel').addEventListener('click', () => {
    const idx = canvas.getSelectedIndex();
    if (idx === null) return;
    confirmBox('确定删除该步骤吗？将级联更新依赖下标。', () => {
      canvas.removeStep(idx);
      renderVarChips();
    }, { danger: true });
  });

  overlay.querySelector('#wfZoomIn').addEventListener('click', () => {
    canvas.setScale(canvas.getScale() + 0.1);
    zoomPct.textContent = Math.round(canvas.getScale() * 100) + '%';
  });
  overlay.querySelector('#wfZoomOut').addEventListener('click', () => {
    canvas.setScale(canvas.getScale() - 0.1);
    zoomPct.textContent = Math.round(canvas.getScale() * 100) + '%';
  });

  overlay.querySelector('#wfBack').addEventListener('click', () => {
    canvas.destroy();
    overlay.remove();
  });

  overlay.querySelector('#wfSave').addEventListener('click', async () => {
    const name = overlay.querySelector('#wfName').value.trim();
    if (!name) { toast('请填写模板名称', 'error'); return; }
    const description = overlay.querySelector('#wfDesc').value.trim();
    const steps = canvas.getSteps();
    if (!steps.length) { toast('至少需要一个步骤', 'error'); return; }
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i].name.trim() || !steps[i].content.trim()) {
        toast(`步骤 ${i + 1} 的名称与内容必填`, 'error');
        return;
      }
    }
    const body = { name, description, steps };
    try {
      if (isEdit) await api.patch(`/api/workflows/${wf.id}`, body);
      else await api.post('/api/workflows', body);
      toast('模板已保存', 'success');
      canvas.destroy();
      overlay.remove();
      done?.();
    } catch (err) {
      toast(err.message || '保存失败', 'error');
    }
  });
}

/* ==================== 执行记录 ==================== */
async function renderRuns(box, ctx) {
  box.innerHTML = `
    <div class="card">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">🧾 执行记录 <span class="sub">点击运行行查看可视化运行图</span></div>
        <button class="btn" id="runsRefresh">⟳ 刷新</button>
      </div>
      <div class="table-wrap" id="runsTable"><div class="loading-line"><span class="spinner"></span> 加载记录…</div></div>
    </div>`;

  async function load() {
    const table = box.querySelector('#runsTable');
    let runs;
    try { runs = await api.get('/api/workflows/runs'); } catch (err) {
      table.innerHTML = emptyHTML('🧾', '执行记录加载失败', err.message);
      return;
    }
    if (!Array.isArray(runs) || !runs.length) {
      table.innerHTML = emptyHTML('🧾', '暂无执行记录', '到「模板」页签点击 ▶ 执行 启动一个工作流');
      return;
    }
    const sorted = [...runs].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    table.innerHTML = `<table class="table">
      <thead><tr><th></th><th>名称</th><th>状态</th><th>进度</th><th>创建时间</th><th>完成时间</th></tr></thead>
      <tbody>${sorted.map((r) => {
        const total = r.step_count || (r.steps?.length || 0) || (r.step_tasks ? Object.keys(r.step_tasks).length : 0);
        const completed = r.steps?.filter((s) => s.status === 'completed').length || 0;
        const pct = total ? Math.round((completed / total) * 100) : 0;
        return `
        <tr class="clickable" data-id="${r.id}">
          <td style="width:30px">▸</td>
          <td>${escapeHtml(r.name || r.id)}</td>
          <td>${RUN_STATUS[r.status] || escapeHtml(r.status)}</td>
          <td><div class="wf-progress-bar"><div class="wf-progress-fill" style="width:${pct}%"></div></div><span class="faint" style="font-size:11px">${completed}/${total}</span></td>
          <td class="mono faint">${fmtTime(r.created_at)}</td>
          <td class="mono faint">${fmtTime(r.completed_at)}</td>
        </tr>`;
      }).join('')}</tbody></table>`;

    table.querySelectorAll('tr.clickable').forEach((tr) => {
      tr.addEventListener('click', async () => {
        try {
          const run = await api.get(`/api/workflows/runs/${tr.dataset.id}`);
          openRunDetail(run, ctx);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  box.querySelector('#runsRefresh').addEventListener('click', load);
  load();
  const timer = setInterval(() => { if (box.isConnected) load(); }, 3000);
  ctx.onCleanup(() => clearInterval(timer));
}

function openRunDetail(run, ctx) {
  const overlay = document.createElement('div');
  overlay.className = 'wf-editor-overlay';
  overlay.innerHTML = `
    <div class="wf-editor">
      <div class="wf-editor-toolbar">
        <div class="flex" style="gap:10px">
          <button class="btn btn-sm" id="runBack">← 返回列表</button>
          <span class="wf-editor-title">运行图：${escapeHtml(run.name || run.id)} · ${run.status}</span>
        </div>
        <div class="flex" style="gap:10px">
          <div class="wf-zoom-wrap">
            <button class="btn btn-sm btn-ghost" id="runZoomOut">－</button>
            <span id="runZoomPct">100%</span>
            <button class="btn btn-sm btn-ghost" id="runZoomIn">＋</button>
          </div>
        </div>
      </div>
      <div class="wf-editor-body">
        <div class="wf-editor-canvas" id="runCanvasWrap"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const wrap = overlay.querySelector('#runCanvasWrap');
  const zoomPct = overlay.querySelector('#runZoomPct');
  const canvas = createWorkflowCanvas({
    el: wrap,
    editable: false,
    onNodeClick: (node, index) => {
      const task = node.task;
      if (!task) return;
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="mb8">${statusBadge(task.status)}</div>
        <p class="muted mb8">步骤 #${index + 1}：${escapeHtml(node.name)}</p>
        <div class="mb8"><div class="muted" style="font-size:12px">任务内容</div><div class="md-p">${renderMarkdown(task.data?.content || '')}</div></div>
        ${task.result?.summary ? `<div class="mb8"><div class="muted" style="font-size:12px">结果摘要</div><div class="md-p">${renderMarkdown(task.result.summary)}</div></div>` : ''}
        ${task.result?.evidence ? `<div class="mb8"><div class="muted" style="font-size:12px">执行证据</div><pre class="json-view">${jsonHighlight(task.result.evidence)}</pre></div>` : ''}
        <div class="faint" style="font-size:12px">创建于 ${fmtTime(task.created_at, true)} · 耗时 ${fmtDuration(task.started_at || task.created_at, task.completed_at || Math.floor(Date.now() / 1000))}</div>
      `;
      openDrawer(`步骤 ${index + 1}：${node.name}`, body.innerHTML);
    },
  });

  canvas.setSteps(run.steps || []);

  overlay.querySelector('#runBack').addEventListener('click', () => {
    canvas.destroy();
    overlay.remove();
  });

  overlay.querySelector('#runZoomIn').addEventListener('click', () => {
    canvas.setScale(canvas.getScale() + 0.1);
    zoomPct.textContent = Math.round(canvas.getScale() * 100) + '%';
  });
  overlay.querySelector('#runZoomOut').addEventListener('click', () => {
    canvas.setScale(canvas.getScale() - 0.1);
    zoomPct.textContent = Math.round(canvas.getScale() * 100) + '%';
  });

  // 运行中的 run 每 3s 刷新
  if (run.status === 'running') {
    const timer = setInterval(async () => {
      if (!overlay.isConnected) { clearInterval(timer); return; }
      try {
        const fresh = await api.get(`/api/workflows/runs/${run.id}`);
        canvas.setSteps(fresh.steps || []);
        if (fresh.status !== 'running') clearInterval(timer);
      } catch { /* ignore */ }
    }, 3000);
  }
}

function truncate(s, len) {
  s = String(s ?? '');
  return s.length > len ? `${s.slice(0, len)}…` : s;
}
