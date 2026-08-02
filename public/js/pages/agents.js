/* ============================================================
   pages/agents.js — 智能体：列表（审核/改名/测试/token/禁用/删除）｜ 接入
   ============================================================ */
import {
  api, toast, escapeHtml, fmtTime, emptyHTML, openModal, confirmBox,
  presenceBadge, jsonHighlight, copyText, renderMarkdown,
} from '../api.js';

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="list">智能体列表</div>
      <div class="tab" data-tab="onboard">接入智能体</div>
    </div>
    <div id="tabBody"><div class="loading-line"><span class="spinner"></span> 加载中…</div></div>`;
  const body = el.querySelector('#tabBody');
  const renderTab = (tab) => {
    el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'list') renderList(body, ctx);
    else renderOnboard(body);
  };
  el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => renderTab(t.dataset.tab)));
  renderTab('list');
}

/* ==================== 智能体列表 ==================== */
async function renderList(box, ctx) {
  box.innerHTML = `
    <div class="card">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">🤖 智能体列表
          <span class="sub">presence：🟢在线 🟡忙碌 🔵空闲 ⚫离线 🟠待审核</span></div>
        <div class="flex">
          <button class="btn" id="agRefresh">⟳ 刷新</button>
        </div>
      </div>
      <div class="filter-bar">
        <label class="field"><span>接入方式</span>
          <select id="fConnType">
            <option value="">全部</option>
            <option value="mcp">🔌 MCP</option>
            <option value="skill">🧩 skill</option>
          </select></label>
        <label class="field"><span>状态</span>
          <select id="fPresence">
            <option value="">全部</option>
            <option value="online">🟢 在线</option>
            <option value="busy">🟡 忙碌</option>
            <option value="idle">🔵 空闲</option>
            <option value="offline">⚫ 离线</option>
            <option value="pending_review">🟠 待审核</option>
          </select></label>
        <label class="field grow"><span>关键字（名称 / 能力 / 主机）</span>
          <input type="text" id="fQ" placeholder="如 trae / code / 192.168"></label>
        <label class="field"><span>能力（多选用逗号）</span>
          <input type="text" id="fCaps" placeholder="如 code, search"></label>
      </div>
      <div id="capHint" class="muted mb8" style="font-size:12px"></div>
      <div class="table-wrap" id="agTable"><div class="loading-line"><span class="spinner"></span> 加载智能体…</div></div>
    </div>`;

  // 全部能力标签（来自当前数据，用于自动补全提示）
  const filter = { q: '', presence: '', connType: '', caps: '' };

  async function load() {
    const table = box.querySelector('#agTable');
    let agents, processingTasks = [];
    try {
      [agents, processingTasks] = await Promise.all([
        api.get('/api/agents'),
        api.get('/api/tasks?status=processing&limit=500').catch(() => []),
      ]);
    } catch (err) {
      table.innerHTML = emptyHTML('🤖', '智能体加载失败', err.message);
      return;
    }

    // 统计所有能力出现次数（用于提示哪些能力最常用）
    const capCount = new Map();
    (agents || []).forEach((a) => (a.capabilities || []).forEach((c) => capCount.set(c, (capCount.get(c) || 0) + 1)));
    const topCaps = [...capCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const hint = box.querySelector('#capHint');
    if (hint) {
      hint.innerHTML = topCaps.length
        ? `常见能力：${topCaps.map(([c, n]) => `<span class="tag" style="cursor:pointer" data-quickcap="${escapeHtml(c)}">${escapeHtml(c)} <span class="faint">${n}</span></span>`).join(' ')} <span class="faint" style="font-size:11px">（点击填入能力筛选）</span>`
        : '';
      hint.querySelectorAll('[data-quickcap]').forEach((t) => {
        t.addEventListener('click', () => {
          const inp = box.querySelector('#fCaps');
          const cur = inp.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
          const c = t.dataset.quickcap;
          if (!cur.includes(c)) cur.push(c);
          inp.value = cur.join(', ');
          filter.caps = inp.value;
          renderRows();
        });
      });
    }

    // 前端筛选
    function pass(a) {
      if (filter.connType && a.connection_type !== filter.connType) return false;
      if (filter.presence) {
        const effective = a.review_status === 'pending_review' ? 'pending_review'
          : (a.review_status === 'disabled' ? 'offline' : a.presence);
        if (effective !== filter.presence) return false;
      }
      if (filter.q) {
        const q = filter.q.toLowerCase();
        const blob = [a.name, a.host, ...(a.capabilities || [])].filter(Boolean).join(' ').toLowerCase();
        if (!blob.includes(q)) return false;
      }
      if (filter.caps) {
        const need = filter.caps.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        const has = a.capabilities || [];
        if (!need.every((c) => has.includes(c))) return false;
      }
      return true;
    }

    function renderRows() {
      const list = (agents || []).filter(pass);
      if (!list.length) {
        table.innerHTML = emptyHTML('🤖', '无匹配的智能体', '调整筛选条件，或到「接入」页签新建');
        return;
      }
      const loadOf = (id) => (Array.isArray(processingTasks) ? processingTasks.filter((t) => t.assigned_to === id).length : 0);
      table.innerHTML = `<table class="table">
        <thead><tr>
          <th>名称</th><th>状态</th><th>接入方式</th><th>能力标签</th><th>来源主机</th>
          <th>负载</th><th>成功率</th><th>最近心跳</th><th>操作</th>
        </tr></thead>
        <tbody>${list.map((a) => {
          const total = a.stats?.total || 0;
          const rate = total ? `${Math.round(((a.stats?.success || 0) / total) * 100)}%` : '—';
          const isPending = a.review_status === 'pending_review';
          const isDisabled = a.review_status === 'disabled';
          const lastBeat = a.last_heartbeat_at || a.mcp_session_at;
          return `<tr data-id="${a.id}">
          <td><a href="javascript:void 0" class="ag-name" data-id="${a.id}" style="color:var(--primary);text-decoration:none"><b>${escapeHtml(a.name)}</b></a>
            ${isPending ? '<div class="faint" style="font-size:11px">等待管理员审核</div>' : ''}</td>
          <td>${presenceBadge(isPending ? 'pending_review' : (isDisabled ? 'offline' : a.presence))}
            ${isDisabled ? '<span class="badge badge-red">已禁用</span>' : ''}
            ${a.review_status === 'rejected' ? '<span class="badge badge-red">已拒绝</span>' : ''}</td>
          <td title="${a.connection_type === 'mcp' ? 'MCP 预发接入' : 'skill 脚本接入'}">${a.connection_type === 'mcp' ? '🔌 MCP' : '🧩 skill'}</td>
          <td><span class="tag-wrap" title="点击编辑能力标签">${(a.capabilities || []).map((c) => `<span class="tag tag-editable">${escapeHtml(c)}</span>`).join('') || '<span class="faint">未设置 ✏️</span>'}</span></td>
          <td class="mono faint">${escapeHtml(a.host || '-')}</td>
          <td class="mono">${loadOf(a.id)} 任务</td>
          <td class="mono">${rate}<span class="faint" style="font-size:11px"> (${a.stats?.success || 0}/${total})</span></td>
          <td class="mono faint">${lastBeat ? fmtTime(lastBeat) : '从未'}</td>
          <td><div class="row-actions">
            ${isPending ? '<button class="btn btn-sm btn-green" data-act="approve">通过</button><button class="btn btn-sm btn-danger" data-act="reject">拒绝</button>' : ''}
            <button class="btn btn-sm" data-act="rename" title="改名">✏️</button>
            <button class="btn btn-sm" data-act="ping" title="测试连通：派发一个 ping 任务给该智能体">📶</button>
            <button class="btn btn-sm" data-act="token" title="重置 token">🔑</button>
            ${isDisabled
              ? '<button class="btn btn-sm" data-act="enable">启用</button>'
              : '<button class="btn btn-sm" data-act="disable">禁用</button>'}
            <button class="btn btn-sm btn-danger" data-act="del">删除</button>
          </div></td>
        </tr>`;
        }).join('')}</tbody></table>`;

      // 绑定行内事件
      table.querySelectorAll('tr[data-id]').forEach((tr) => {
        const id = tr.dataset.id;
        const agent = agents.find((x) => x.id === id);
        tr.querySelector('.ag-name').addEventListener('click', () => openAgentDetail(agent, agents, load));
        tr.querySelector('.tag-wrap').addEventListener('click', () => openEditCapabilities(agent, load));
        tr.querySelectorAll('[data-act]').forEach((btn) => {
          btn.addEventListener('click', () => handleAgentAction(btn.dataset.act, agent, load));
        });
      });
    }

    renderRows();
  }

  // 事件绑定（筛选）
  box.querySelector('#agRefresh').addEventListener('click', load);
  box.querySelector('#fConnType').addEventListener('change', (e) => { filter.connType = e.target.value; load(); });
  box.querySelector('#fPresence').addEventListener('change', (e) => { filter.presence = e.target.value; load(); });
  box.querySelector('#fQ').addEventListener('input', (e) => { filter.q = e.target.value.trim(); load(); });
  box.querySelector('#fCaps').addEventListener('input', (e) => { filter.caps = e.target.value.trim(); load(); });

  load();
  const timer = setInterval(() => { if (box.isConnected) load(); }, 15000);
  ctx.onCleanup(() => clearInterval(timer));
}

/** 集中处理行内操作，便于多处复用（含详情抽屉的"删除"按钮） */
async function handleAgentAction(act, agent, done) {
  const run = async (fn) => { try { await fn(); } catch (err) { toast(err.message, 'error'); } };
  if (act === 'approve') await run(async () => { await api.patch(`/api/agents/${agent.id}`, { action: 'approve' }); toast(`已通过「${agent.name}」的接入审核`, 'success'); done?.(); });
  else if (act === 'reject') await run(async () => { await api.patch(`/api/agents/${agent.id}`, { action: 'reject' }); toast('已拒绝该智能体接入', 'success'); done?.(); });
  else if (act === 'rename') openRename(agent, done);
  else if (act === 'ping') await run(async () => {
    await api.post('/api/tasks', { type: 'query_info', data: { content: 'ping：请回复 pong 及你的基本信息' }, target_agent: agent.id });
    toast(`已向「${agent.name}」派发连通性测试任务，请到任务中心查看结果`, 'success');
  });
  else if (act === 'token') await run(async () => {
    const data = await api.post(`/api/agents/${agent.id}/token/reset`);
    openModal({
      title: '新 Token（仅显示一次，请妥善保存）',
      body: `<pre class="json-view">${escapeHtml(data.token)}</pre>
             <p class="faint" style="font-size:12px">旧 token 立即失效，agent 需要用此新 token 重新注册或下次心跳被拒。</p>`,
      okText: '复 制',
      onOk: async () => { copyText(data.token); },
    });
    done?.();
  });
  else if (act === 'disable') await run(async () => { await api.patch(`/api/agents/${agent.id}`, { action: 'disable' }); toast('已禁用', 'success'); done?.(); });
  else if (act === 'enable') await run(async () => { await api.patch(`/api/agents/${agent.id}`, { action: 'enable' }); toast('已启用', 'success'); done?.(); });
  else if (act === 'del') openDeleteAgent(agent, done);
}

/** 二次确认删除：要求输入智能体名称 */
function openDeleteAgent(agent, done) {
  const m = openModal({
    title: `⚠️ 删除智能体「${agent.name}」`,
    body: `
      <p class="mb8">此操作<strong>不可恢复</strong>：</p>
      <ul style="margin:0 0 12px 18px;line-height:1.8;font-size:13px">
        <li>智能体将被立即从系统中移除</li>
        <li>其 token 立即失效，正在执行的智能体会被拒</li>
        <li>历史任务记录<strong>保留</strong>（仅显示为「已删除」）</li>
      </ul>
      <label class="field"><span>请输入智能体名称 <code>${escapeHtml(agent.name)}</code> 以确认</span>
        <input type="text" id="delConfirm" placeholder="精确匹配"></label>`,
    okText: '永 久 删 除',
    onOk: async (modal) => {
      const v = modal.querySelector('#delConfirm').value.trim();
      if (v !== agent.name) { toast('名称不匹配，已取消', 'error'); return false; }
      await api.del(`/api/agents/${agent.id}`);
      toast('已删除', 'success');
      done?.();
    },
  });
  m.el.querySelector('.btn-ok').classList.add('btn-danger');
}

/** 智能体详情抽屉：基本信息 + 接入信息 + 能力 + 最近任务 + 操作 */
async function openAgentDetail(agent, allAgents, onChange) {
  const bodyEl = openDrawer(`🤖 ${agent.name}`, '<div class="loading-line"><span class="spinner"></span> 加载详情…</div>');
  // 拉取最近任务（10 条）
  let recentTasks = [];
  try {
    const list = await api.get(`/api/tasks?agent=${agent.id}&limit=10`);
    recentTasks = Array.isArray(list) ? list : [];
  } catch { /* 忽略 */ }
  const isPending = agent.review_status === 'pending_review';
  const isDisabled = agent.review_status === 'disabled';
  const isRejected = agent.review_status === 'rejected';
  const total = agent.stats?.total || 0;
  const rate = total ? Math.round(((agent.stats?.success || 0) / total) * 100) : null;
  const lastBeat = agent.last_heartbeat_at || agent.mcp_session_at;
  const effectivePresence = isPending ? 'pending_review' : (isDisabled ? 'offline' : agent.presence);

  bodyEl.innerHTML = `
    <div class="card" style="box-shadow:none">
      <div class="flex-between mb8">
        <div>
          ${presenceBadge(effectivePresence)}
          <span class="badge ${isDisabled ? 'badge-red' : isRejected ? 'badge-red' : 'badge-green'}">
            ${isPending ? '待审核' : isDisabled ? '已禁用' : isRejected ? '已拒绝' : '已激活'}
          </span>
          <span class="badge">${agent.connection_type === 'mcp' ? '🔌 MCP 接入' : '🧩 skill 接入'}</span>
        </div>
        <div class="row-actions">
          ${isPending ? '<button class="btn btn-sm btn-green" data-detail="approve">通过</button><button class="btn btn-sm btn-danger" data-detail="reject">拒绝</button>' : ''}
          <button class="btn btn-sm" data-detail="rename">✏️ 改名</button>
          <button class="btn btn-sm" data-detail="ping">📶 连通测试</button>
          <button class="btn btn-sm" data-detail="token">🔑 重置 token</button>
          ${isDisabled
            ? '<button class="btn btn-sm btn-green" data-detail="enable">启用</button>'
            : '<button class="btn btn-sm" data-detail="disable">禁用</button>'}
          <button class="btn btn-sm btn-danger" data-detail="del">删除</button>
        </div>
      </div>
      <p class="muted mono" style="font-size:11px">ID：${escapeHtml(agent.id)}</p>
    </div>

    <div class="card" style="box-shadow:none">
      <div class="card-title">🔌 接入信息</div>
      <table class="table"><tbody>
        <tr><td class="muted" style="width:120px">接入方式</td><td>${agent.connection_type === 'mcp' ? '🔌 MCP（预发 + 复制 mcp_config）' : '🧩 skill（客户端通过 skill.md 调 register）'}</td></tr>
        <tr><td class="muted">来源主机</td><td class="mono">${escapeHtml(agent.host || '-')}</td></tr>
        <tr><td class="muted">skill 版本</td><td class="mono">${escapeHtml(agent.skill_version || '-')}</td></tr>
        <tr><td class="muted">最近心跳</td><td class="mono">${lastBeat ? fmtTime(lastBeat, true) : '<span class="faint">从未</span>'}</td></tr>
        <tr><td class="muted">创建时间</td><td class="mono">${fmtTime(agent.created_at, true)}</td></tr>
      </tbody></table>
    </div>

    <div class="card" style="box-shadow:none">
      <div class="card-title">🏷️ 能力标签 <button class="btn btn-sm" data-detail="caps" style="float:right">编辑</button></div>
      <div>${(agent.capabilities || []).length
        ? (agent.capabilities || []).map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join(' ')
        : '<span class="faint">未设置</span>'}</div>
    </div>

    <div class="card" style="box-shadow:none">
      <div class="card-title">📊 统计</div>
      <table class="table"><tbody>
        <tr><td class="muted" style="width:120px">累计任务</td><td>${total}</td></tr>
        <tr><td class="muted">成功数</td><td>${agent.stats?.success || 0}</td></tr>
        <tr><td class="muted">成功率</td><td>${rate == null ? '-' : rate + '%'}</td></tr>
      </tbody></table>
    </div>

    <div class="card" style="box-shadow:none">
      <div class="card-title">🕘 最近任务（最近 10 条）</div>
      ${recentTasks.length
        ? `<table class="table"><thead><tr><th>内容</th><th>状态</th><th>耗时</th><th>时间</th></tr></thead>
           <tbody>${recentTasks.map((t) => `<tr>
             <td style="max-width:240px">${escapeHtml(truncate(t.data?.content, 40))}</td>
             <td>${statusBadge(t.status)}</td>
             <td class="mono faint">${t.status === 'pending' ? '-' : (() => {
               const s = t.started_at, e = t.completed_at;
               if (!s) return '-';
               const secs = Math.max(0, (e || Math.floor(Date.now()/1000)) - s);
               if (secs<60) return secs+'s'; if (secs<3600) return Math.floor(secs/60)+'m'; return Math.floor(secs/3600)+'h';
             })()}</td>
             <td class="mono faint">${fmtTime(t.created_at)}</td>
           </tr>`).join('')}</tbody></table>`
        : '<p class="faint">尚无任务记录</p>'}
    </div>`;

  // 绑定抽屉内操作
  bodyEl.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.detail;
      if (act === 'caps') {
        openEditCapabilities(agent, async () => { closeDrawer(); await openAgentDetail({ ...agent }, allAgents, onChange); onChange?.(); });
        return;
      }
      const reload = async () => { closeDrawer(); onChange?.(); };
      if (act === 'rename' || act === 'token' || act === 'del') {
        if (act === 'rename') openRename(agent, reload);
        else if (act === 'token') {
          await handleAgentAction('token', agent, reload);
        } else if (act === 'del') openDeleteAgent(agent, reload);
        return;
      }
      await handleAgentAction(act, agent, reload);
    });
  });
}

function openRename(agent, done) {
  openModal({
    title: `改名 · ${agent.name}`,
    body: `<label class="field"><span>新名称</span><input type="text" id="newName" value="${escapeHtml(agent.name)}"></label>`,
    okText: '保 存',
    onOk: async (modal) => {
      const name = modal.querySelector('#newName').value.trim();
      if (!name) { toast('名称不能为空', 'error'); return false; }
      await api.patch(`/api/agents/${agent.id}`, { name });
      toast('已改名', 'success');
      done?.();
    },
  });
}

function openEditCapabilities(agent, done) {
  openModal({
    title: `编辑能力标签 · ${agent.name}`,
    body: `<label class="field"><span>能力标签（逗号分隔，如 code, search, write）</span>
      <input type="text" id="caps" value="${escapeHtml((agent.capabilities || []).join(', '))}"></label>`,
    okText: '保 存',
    onOk: async (modal) => {
      const caps = modal.querySelector('#caps').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      await api.patch(`/api/agents/${agent.id}`, { capabilities: caps });
      toast('能力标签已更新', 'success');
      done?.();
    },
  });
}

function openNewMcp(done) {
  // 保留为兼容入口：直接打开 MCP 通道面板并提示用户填表
  toast('请到「接入智能体」页签切到 🔌 MCP 通道填写名称与能力', 'info');
  done?.();
}

/* ==================== 接入智能体 ==================== */
const ENV_GUIDES = {
  trae: {
    name: 'Trae（国际版）',
    steps: [
      '下载下方 skill.md，保存到本地；',
      '打开 Trae → 设置 → Rules / Skills，导入该 skill 文件；',
      'skill 内的脚本会调用 `POST /api/agent/register` 完成注册；',
      '回到「智能体列表」页签，管理员点击「通过」完成审核；',
      '之后智能体将周期性调用 `GET /api/heartbeat` 与 `GET /api/task/poll` 领取任务。',
    ],
  },
  'trae-cn': {
    name: 'Trae CN（国内版）',
    steps: [
      '下载下方 skill.md，保存到本地；',
      '打开 Trae CN → 设置 → 规则，粘贴 skill 内容；',
      '注意将 skill 中的服务地址改为你部署 ai-bridge 的内网/公网地址；',
      '注册成功后在「智能体列表」审核通过即可开始协作。',
    ],
  },
  cursor: {
    name: 'Cursor',
    steps: [
      '下载下方 skill.md；',
      '在 Cursor 中创建项目级 `.cursorrules` 或工作区规则文件，把 skill 内容粘贴进去；',
      '新建对话时 AI 会读取规则并按 skill 协议执行；',
      'skill 中调用的 `POST /api/agent/register` 会向当前平台注册；',
      '管理员在「智能体列表」通过审核后 AI 即可领取任务。',
    ],
  },
  cline: {
    name: 'Cline / Continue',
    steps: [
      '下载下方 skill.md；',
      '在 VS Code 中打开 Cline / Continue 扩展的自定义指令面板；',
      '把 skill 全文作为「System Prompt」或「Custom Instructions」导入；',
      '让 AI 触发 `POST /api/agent/register` 完成注册；',
      '管理员审核通过后 AI 即可开始执行任务。',
    ],
  },
  custom: {
    name: '自定义（任意脚本 / 其他 IDE）',
    steps: [
      '任意可发起 HTTP 请求的环境均可接入，遵循 skill.md 中的协议；',
      '注册：`POST /api/agent/register`（无需凭证，返回一次性 token）；',
      '心跳：`GET /api/heartbeat?agent_id&token`（建议每 10 秒）；',
      '领任务：`GET /api/task/poll?agent_id&token&timeout=30`（长轮询）；',
      '交结果：`POST /api/task/complete`（携带 result.summary 与 evidence）；',
      '若客户端支持 MCP，也可切到「MCP 通道」页签创建 MCP 接入并粘贴 mcp_config。',
    ],
  },
};

/** 通道对比表 */
const COMPARE_ROWS = [
  ['使用场景', '已有 AI IDE（Trae / Cursor / Cline 等）想让它调用本平台', '把本平台当 MCP server 接入客户端'],
  ['客户端类型', 'AI IDE / 任意能执行脚本的环境', '支持 MCP 协议的客户端（Trae / Cline / 自研）'],
  ['谁先发起', '客户端主动调 `register` 注册', '平台先创建智能体，客户端粘贴 mcp_config'],
  ['注册时机', '第一次接入时', '在「接入」页签手动创建并复制 mcp_config'],
  ['心跳频率', '建议每 10s（GET /api/heartbeat）', '通过 MCP session 自动维护（mcp_session_at）'],
  ['适用任务', '复杂多步、需要 AI 自主决策', '结构化工具调用、协议化集成'],
  ['调试难度', '需要看 IDE 日志', 'mcp_config 标准化，便于追踪'],
];

async function renderOnboard(box) {
  box.innerHTML = `
    <div class="card">
      <div class="card-title">🧩 接入智能体 <span class="sub">MCP 与 skill 是对等的两个通道，按你的客户端类型任选其一</span></div>
      <p class="muted" style="font-size:13px;line-height:1.7">
        本平台提供两种方式让外部 AI 客户端接入，<b>能力等价、管理统一</b>：
        <b>🧩 skill 通道</b> —— 下载 <code>ai-bridge.skill.md</code>，由 AI 在执行任务时主动调本平台 API 注册并领活；
        <b>🔌 MCP 通道</b> —— 平台先预发好配置（含 token），客户端粘贴 mcp_config 即可。
        下文按通道分两面板介绍安装部署方法。
      </p>
    </div>

    <!-- 通道切换器 -->
    <div class="channel-tabs" role="tablist">
      <div class="channel-tab skill active" data-ch="skill" role="tab" aria-selected="true">
        <div class="ch-icon">🧩</div>
        <div>
          <div class="ch-label">skill 通道</div>
          <div class="ch-desc">下载 skill.md，AI 主动接入平台</div>
        </div>
        <span class="ch-badge">推荐</span>
      </div>
      <div class="channel-tab mcp" data-ch="mcp" role="tab" aria-selected="false">
        <div class="ch-icon">🔌</div>
        <div>
          <div class="ch-label">MCP 通道</div>
          <div class="ch-desc">平台预发 mcp_config，客户端粘贴即用</div>
        </div>
        <span class="ch-badge">标准协议</span>
      </div>
    </div>

    <!-- ========== skill 通道面板 ========== -->
    <div class="channel-panel active" data-panel="skill" role="tabpanel">
      <div class="card" style="box-shadow:none">
        <div class="card-title">🧩 skill 通道 · 安装部署</div>
        <p class="muted" style="font-size:13px;line-height:1.7">
          适合任意 AI IDE（Trae / Cursor / Cline / 自研环境）。平台把完整的「注册 / 心跳 / 领任务 / 交结果」协议打包成
          <code>ai-bridge.skill.md</code>，AI 加载后即可在执行任务时主动调用本平台 API。
        </p>

        <div class="step-flow">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-title">选择环境</div>
            <div class="step-desc">下方下拉选择你的 AI IDE，获取对应步骤</div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div class="step-title">下载 skill.md</div>
            <div class="step-desc">点击下载并保存到本地，含完整协议</div>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <div class="step-title">导入 AI 客户端</div>
            <div class="step-desc">按当前环境步骤把 skill 喂给 AI</div>
          </div>
          <div class="step">
            <div class="step-num">4</div>
            <div class="step-title">注册并审核</div>
            <div class="step-desc">AI 自动调 register，管理员通过后上线</div>
          </div>
        </div>

        <div class="form-row">
          <label class="field"><span>当前 AI IDE 环境</span>
            <select id="envSel" class="form-input">
              <option value="trae">Trae（国际版）</option>
              <option value="trae-cn">Trae CN（国内版）</option>
              <option value="cursor">Cursor</option>
              <option value="cline">Cline / Continue</option>
              <option value="custom">自定义 / 其他环境</option>
            </select></label>
          <div class="field" style="display:flex;align-items:flex-end">
            <button class="btn btn-primary" id="dlSkill" style="width:100%">⬇ 下载 ai-bridge.skill.md</button>
          </div>
        </div>

        <div class="card" style="box-shadow:none;background:var(--bg-soft);padding:14px 16px;margin-top:0">
          <div class="card-title" style="margin-bottom:8px">📋 当前环境详细步骤 <span id="envName" class="sub"></span></div>
          <ol id="envSteps" style="line-height:2;font-size:13px;padding-left:20px;margin:0"></ol>
        </div>

        <p class="faint mt8" style="font-size:12px">
          💡 skill.md 由后端 <code>GET /api/system/skill</code> 提供，内容见下方「skill 协议全文」。
        </p>
      </div>
    </div>

    <!-- ========== MCP 通道面板 ========== -->
    <div class="channel-panel" data-panel="mcp" role="tabpanel">
      <div class="card" style="box-shadow:none">
        <div class="card-title">🔌 MCP 通道 · 预发与部署</div>
        <p class="muted" style="font-size:13px;line-height:1.7">
          适合支持 MCP 协议的客户端（Trae / Cline / 自研 MCP host）。平台先在「智能体列表」生成一个 MCP 接入项（含 token 和 mcp_config），
          你把 <code>mcp_config</code> 粘贴到客户端 MCP 设置即可通信——<b>无需客户端先发起注册</b>。
        </p>

        <div class="step-flow">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-title">创建 MCP 接入</div>
            <div class="step-desc">下方填名称与能力，创建后立即激活</div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div class="step-title">复制 mcp_config</div>
            <div class="step-desc">弹窗中含 token，token 仅显示一次</div>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <div class="step-title">粘贴到客户端</div>
            <div class="step-desc">客户端 → 设置 → MCP → 合并 JSON</div>
          </div>
          <div class="step">
            <div class="step-num">4</div>
            <div class="step-title">自动上线</div>
            <div class="step-desc">MCP session 自动维护，无需审核</div>
          </div>
        </div>

        <div class="form-row" style="margin-bottom:0">
          <label class="field"><span>智能体名称 *</span>
            <input type="text" id="mcpName" placeholder="如：Trae 编码助手"></label>
          <label class="field"><span>能力标签（逗号分隔）</span>
            <input type="text" id="mcpCaps" placeholder="如 code, debug, search"></label>
        </div>
        <button class="btn btn-green" id="btnNewMcp">＋ 创建 MCP 接入（生成 mcp_config）</button>
        <p class="faint mt8" style="font-size:12px">💡 创建后 token 与 mcp_config 仅显示一次，请立即复制并妥善保存</p>

        <div id="mcpCfgBox"></div>
      </div>
    </div>

    <!-- ========== 通用：通道对比 ========== -->
    <div class="card" style="box-shadow:none">
      <div class="card-title">⚖️ 通道对比</div>
      <table class="table">
        <thead><tr><th style="width:140px">维度</th><th>🧩 skill 通道</th><th>🔌 MCP 通道</th></tr></thead>
        <tbody>${COMPARE_ROWS.map((r) => `<tr>
          <td class="compare-key">${r[0]}</td>
          <td>${r[1]}</td>
          <td>${r[2]}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>

    <!-- ========== 通用：skill 协议全文 ========== -->
    <div class="card" style="box-shadow:none">
      <div class="card-title">📄 skill 协议全文（GET /api/system/skill）</div>
      <div id="skillBody"><div class="loading-line"><span class="spinner"></span> 加载 skill 文档…</div></div>
    </div>`;

  // 通道 tab 切换
  const tabs = box.querySelectorAll('.channel-tab');
  const panels = box.querySelectorAll('.channel-panel');
  tabs.forEach((t) => t.addEventListener('click', () => {
    const ch = t.dataset.ch;
    tabs.forEach((x) => {
      const on = x.dataset.ch === ch;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === ch));
  }));

  // skill 通道：环境切换展示步骤
  const envName = box.querySelector('#envName');
  const stepsBox = box.querySelector('#envSteps');
  const renderSteps = () => {
    const g = ENV_GUIDES[box.querySelector('#envSel').value];
    envName.textContent = `· ${g.name}`;
    stepsBox.innerHTML = g.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  };
  box.querySelector('#envSel').addEventListener('change', renderSteps);
  renderSteps();

  // skill 文档加载
  let skillContent = '';
  try {
    const data = await api.get('/api/system/skill');
    skillContent = data.content || '';
    box.querySelector('#skillBody').innerHTML = skillContent.trim()
      ? renderMarkdown(skillContent)
      : emptyHTML('📄', 'skill 文档为空', 'docs/ai-bridge.skill.md 尚未由后端生成');
  } catch (err) {
    box.querySelector('#skillBody').innerHTML = emptyHTML('📄', 'skill 文档加载失败', err.message);
  }

  box.querySelector('#dlSkill').addEventListener('click', () => {
    if (!skillContent.trim()) { toast('skill 文档为空，暂无法下载', 'error'); return; }
    const blob = new Blob([skillContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ai-bridge.skill.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('已开始下载 skill.md', 'success');
  });

  // MCP 通道：创建按钮 — 直接读输入框，无需弹窗
  box.querySelector('#btnNewMcp').addEventListener('click', async () => {
    const nameEl = box.querySelector('#mcpName');
    const capsEl = box.querySelector('#mcpCaps');
    const name = nameEl.value.trim();
    if (!name) { toast('请填写智能体名称', 'error'); nameEl.focus(); return; }
    const caps = capsEl.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const out = box.querySelector('#mcpCfgBox');
    out.innerHTML = '<div class="loading-line"><span class="spinner"></span> 正在创建并生成 mcp_config…</div>';
    try {
      const data = await api.post('/api/agents', { name, capabilities: caps, connection_type: 'mcp' });
      const cfg = JSON.stringify(data.mcp_config, null, 2);
      out.innerHTML = `
        <div class="card" style="box-shadow:none;margin-top:14px;border-left:4px solid #3b82f6">
          <div class="flex-between mb8">
            <div class="card-title" style="margin:0">✅ 已创建 · ${escapeHtml(name)}</div>
            <span class="badge badge-blue">agent_id：${escapeHtml(data.agent_id)}</span>
          </div>
          <p class="muted" style="font-size:13px;line-height:1.7;margin-bottom:8px">
            合并下面 JSON 到客户端的 MCP 配置（如 Trae → Settings → MCP Servers）。
            <b style="color:var(--red)">token 仅此一次完整显示，请立即复制保存。</b>
          </p>
          <pre class="json-view" style="max-height:280px;overflow:auto">${jsonHighlight(data.mcp_config)}</pre>
          <div class="flex mt8" style="gap:8px">
            <button class="btn btn-primary" id="cpCfg">📋 复制 mcp_config</button>
            <button class="btn" id="cpTok">🔑 单独复制 token</button>
            <button class="btn" id="cpAll">📑 复制全部（含 token 明文）</button>
          </div>
        </div>`;
      out.querySelector('#cpCfg').addEventListener('click', () => copyText(cfg, 'mcp_config 已复制'));
      out.querySelector('#cpTok').addEventListener('click', () => copyText(data.token, 'token 已复制'));
      out.querySelector('#cpAll').addEventListener('click', () => copyText(JSON.stringify({ agent_id: data.agent_id, token: data.token, mcp_config: data.mcp_config }, null, 2), '完整信息已复制'));
      toast(`已创建 MCP 接入「${name}」`, 'success');
    } catch (err) {
      out.innerHTML = emptyHTML('⚠️', '创建失败', err.message);
      toast(err.message, 'error');
    }
  });
}
