/* ============================================================
   pages/chat.js — 对话：会话列表 ｜ 消息流 ｜ 任务详情
   发送 = POST /api/chat → 每 2s 轮询任务直到 completed/failed → 回填"智能体回复"
   ============================================================ */
import {
  api, toast, escapeHtml, fmtTime, truncate, emptyHTML,
  jsonHighlight, openModal, confirmBox, statusBadge, safeText, renderMarkdown,
} from '../api.js';
import { openTaskDrawer } from '../task-drawer.js';
import { renderArtifactCards, bindArtifactCards } from '../artifact-cards.js';

const state = {
  sessions: [],
  current: null,       // 当前会话 id
  messages: [],        // 当前会话任务列表
  agents: [],
  sending: false,
};

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="chat-layout">
      <div class="chat-col">
        <div class="chat-col-head">会话 <button class="btn btn-sm btn-green" id="newSession">＋ 新建</button></div>
        <div class="chat-col-body" id="sessionList"><div class="loading-line"><span class="spinner"></span></div></div>
      </div>
      <div class="chat-col">
        <div class="chat-col-head">
          <button class="btn btn-sm btn-ghost chat-mobile-only" id="chatBack" title="返回会话列表" style="margin-right:6px">←</button>
          <span id="chatHead">消息</span>
        </div>
        <div class="chat-col-body" id="msgFlow"></div>
        <div class="chat-input-area">
          <select id="chatTarget" style="width:130px; flex:0 0 auto" title="指定智能体（可选）"></select>
          <div class="chat-input-wrap">
            <div id="chatHint" class="chat-hint" style="display:none"></div>
            <div id="routeHint" class="route-hint" style="display:none"></div>
            <textarea id="chatInput" placeholder="输入消息，Enter 发送（Shift+Enter 换行）\n支持 /prompt /workflow /kb /note 和 @agentName"></textarea>
          </div>
          <button class="btn btn-primary" id="chatSend">发 送</button>
        </div>
      </div>
    </div>`;

  try {
    state.agents = await api.get('/api/agents');
  } catch { state.agents = []; }
  el.querySelector('#chatTarget').innerHTML =
    '<option value="">🎯 自动分配</option>' +
    state.agents.filter((a) => a.review_status === 'active')
      .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');

  await loadSessions(el, ctx);

  el.querySelector('#newSession').addEventListener('click', () => {
    openModal({
      title: '新建会话',
      body: '<label class="field"><span>会话名称</span><input type="text" id="sName" placeholder="如：代码评审讨论"></label>',
      okText: '创 建',
      onOk: async (modal) => {
        const name = modal.querySelector('#sName').value.trim() || `会话 ${new Date().toLocaleString('zh-CN')}`;
        const s = await api.post('/api/sessions', { name });
        toast('会话已创建', 'success');
        state.current = s.id;
        await loadSessions(el, ctx);
      },
    });
  });

  el.querySelector('#chatSend').addEventListener('click', () => sendMessage(el, ctx));
  const input = el.querySelector('#chatInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(el, ctx); }
  });
  input.addEventListener('input', () => updateInputHint(el));
  input.addEventListener('focus', () => updateInputHint(el));
  input.addEventListener('blur', () => {
    setTimeout(() => el.querySelector('#chatHint')?.style.setProperty('display', 'none'), 180);
  });

  // 移动端：会话列切换
  el.querySelector('#chatBack')?.addEventListener('click', () => {
    document.body.classList.add('chat-show-sessions');
  });
  // 点击会话项后回到消息视图
  el.querySelector('#sessionList')?.addEventListener('click', () => {
    document.body.classList.remove('chat-show-sessions');
  }, true);
}

async function loadSessions(el, ctx) {
  const list = el.querySelector('#sessionList');
  try {
    state.sessions = await api.get('/api/sessions');
  } catch (err) {
    list.innerHTML = emptyHTML('💬', '会话加载失败', err.message);
    return;
  }
  if (!state.current || !state.sessions.some((s) => s.id === state.current)) {
    const active = state.sessions.find((s) => s.status !== 'archived');
    state.current = active ? active.id : null;
  }
  renderSessionList(el, ctx);
  if (state.current) await loadMessages(el, ctx);
  else el.querySelector('#msgFlow').innerHTML = emptyHTML('💬', '暂无会话', '点击「新建」开始一段对话');
}

function renderSessionList(el, ctx) {
  const list = el.querySelector('#sessionList');
  const actives = state.sessions.filter((s) => s.status !== 'archived');
  const archived = state.sessions.filter((s) => s.status === 'archived');
  const itemHTML = (s) => `
    <div class="session-item${s.id === state.current ? ' active' : ''}" data-id="${s.id}">
      <span class="s-name" title="${escapeHtml(s.name)}">${s.status === 'archived' ? '🗄️ ' : ''}${escapeHtml(s.name)}</span>
      ${s.context_summary ? `<span class="s-summary" title="${escapeHtml(s.context_summary)}">🧠 已总结</span>` : ''}
      <span class="s-ops">
        <button class="btn btn-sm btn-ghost" data-op="rename" title="重命名">✏️</button>
        ${s.status === 'archived'
          ? '<button class="btn btn-sm btn-ghost" data-op="unarchive" title="恢复">📤</button>'
          : '<button class="btn btn-sm btn-ghost" data-op="archive" title="归档">🗄️</button>'}
        ${s.id === 'session-default' ? '' : '<button class="btn btn-sm btn-ghost" data-op="del" title="删除">🗑️</button>'}
      </span>
    </div>`;
  list.innerHTML =
    (actives.map(itemHTML).join('') || emptyHTML('💬', '暂无会话')) +
    (archived.length ? `<p class="faint mt8 mb8" style="font-size:12px">── 已归档 ──</p>${archived.map(itemHTML).join('')}` : '');

  list.querySelectorAll('.session-item').forEach((item) => {
    const id = item.dataset.id;
    const s = state.sessions.find((x) => x.id === id);
    item.addEventListener('click', async (e) => {
      if (e.target.closest('[data-op]')) return;
      state.current = id;
      renderSessionList(el, ctx);
      await loadMessages(el, ctx);
    });
    item.querySelectorAll('[data-op]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const op = btn.dataset.op;
        try {
          if (op === 'rename') {
            openModal({
              title: '重命名会话',
              body: `<label class="field"><span>新名称</span><input type="text" id="rn" value="${escapeHtml(s.name)}"></label>`,
              okText: '保 存',
              onOk: async (modal) => {
                const name = modal.querySelector('#rn').value.trim();
                if (!name) { toast('名称不能为空', 'error'); return false; }
                await api.patch(`/api/sessions/${id}`, { name });
                toast('已重命名', 'success');
                await loadSessions(el, ctx);
              },
            });
          } else if (op === 'archive') {
            await api.patch(`/api/sessions/${id}`, { status: 'archived' });
            toast('已归档', 'success');
            await loadSessions(el, ctx);
          } else if (op === 'unarchive') {
            await api.patch(`/api/sessions/${id}`, { status: 'active' });
            toast('已恢复', 'success');
            await loadSessions(el, ctx);
          } else if (op === 'del') {
            confirmBox(`确定删除会话「${s.name}」吗？其中任务将移至默认会话。`, async () => {
              await api.del(`/api/sessions/${id}`);
              toast('会话已删除', 'success');
              if (state.current === id) state.current = null;
              await loadSessions(el, ctx);
            });
          }
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  });
}

async function loadMessages(el, ctx) {
  const flow = el.querySelector('#msgFlow');
  const s = state.sessions.find((x) => x.id === state.current);
  el.querySelector('#chatHead').textContent = s ? `消息 · ${s.name}` : '消息';
  flow.innerHTML = '<div class="loading-line"><span class="spinner"></span> 加载消息…</div>';
  try {
    state.messages = await api.get(`/api/chat/${state.current}/messages`);
  } catch (err) {
    flow.innerHTML = emptyHTML('💬', '消息加载失败', err.message);
    return;
  }
  renderMessages(el, ctx);
}

function renderMessages(el, ctx, keepScroll = false) {
  const flow = el.querySelector('#msgFlow');
  if (!flow) return;
  const atBottom = keepScroll ? false : flow.scrollTop + flow.clientHeight >= flow.scrollHeight - 40;
  if (!state.messages.length) {
    flow.innerHTML = emptyHTML('🌱', '这个会话还没有消息', '在下方输入内容，发送给智能体试试');
    return;
  }
  const now = Date.now() / 1000;
  flow.innerHTML = `<div class="msg-flow">${state.messages.map((t) => {
    const done = t.status === 'completed';
    const failed = t.status === 'failed';
    const processing = t.status === 'processing';
    const isSystem = t.source === 'system' || t.source === 'kb' || t.type === 'system_note';
    const agent = state.agents.find((a) => a.id === (t.assigned_to || t.target_agent));
    const elapsed = processing && t.started_at ? Math.max(0, Math.round(now - t.started_at)) : 0;
    const dur = t.started_at && t.completed_at ? Math.max(0, t.completed_at - t.started_at) : 0;
    const agentName = escapeHtml(agent?.name || '智能体');
    const evidence = buildEvidenceBar(t);
    const hasEvidence = !!evidence;
    const artifacts = done && Array.isArray(t.result?.artifacts) ? t.result.artifacts : null;
    const artHTML = artifacts && artifacts.length ? renderArtifactCards(artifacts) : '';
    const failedActions = failed ? `
        <div class="msg-actions" style="margin-top:8px;display:flex;gap:8px">
          <button class="btn btn-sm btn-danger btn-retry" data-task="${t.id}">🔄 重试</button>
          <button class="btn btn-sm btn-ghost btn-reassign" data-task="${t.id}">↪ 改派给其他 agent</button>
        </div>` : '';
    // 任务状态条（执行中/已完成/失败）
    const statusBar = isSystem ? '' : `
      <div class="task-status-bar ${done ? 'is-done' : failed ? 'is-failed' : 'is-running'}" data-task="${t.id}" title="点击查看任务详情">
        ${done ? `✅ 已完成 · 用时 ${dur}s · ${agentName}` : failed ? `❌ 失败 · ${agentName}` : processing ? `⏳ 执行中 · 已用时 ${elapsed}s · ${agentName}${t.progress ? ` · ${safeText(t.progress)}` : ''}` : `⏳ 等待分配智能体…`}
      </div>`;
    if (isSystem) {
      return `
    <div class="msg-row sys">
      <div>
        <div class="msg-bubble" data-task="${t.id}">${renderMarkdown(t.result?.summary || t.data?.content || '')}</div>
        <div class="msg-meta">系统 · ${fmtTime(t.completed_at || t.created_at)}</div>
      </div>
    </div>`;
    }
    return `
    <div class="msg-row user">
      <div>
        <div class="msg-bubble" data-task="${t.id}" style="cursor:pointer" title="点击查看任务详情">${safeText(t.data?.content || '')}</div>
        <div class="msg-meta" style="text-align:right">我 · ${fmtTime(t.created_at)}</div>
      </div>
    </div>
    <div class="msg-row ${done ? 'agent' : failed ? 'agent' : 'sys'}">
      <div>
        <div class="msg-bubble ${hasEvidence ? 'msg-bubble-with-evidence' : ''}" data-task="${t.id}" style="cursor:pointer" title="点击查看任务详情">${
          done ? renderMarkdown(t.result?.summary || '（完成，无摘要）')
            : failed ? `<span style="color:var(--red)">❌ 执行失败</span><div class="md-p">${renderMarkdown(t.result?.summary || '未知原因')}</div>${failedActions}`
            : processing
              ? `<span class="spinner"></span> <b>${agentName}</b> 已接单，执行中…（已用时 ${elapsed}s）${t.progress ? `<div class="msg-progress">⏳ ${safeText(t.progress)}</div>` : ''}`
              : `<span class="spinner"></span> 等待分配智能体…`
        }${artHTML}</div>
        ${statusBar}
        ${hasEvidence ? evidence : ''}
        ${renderKbReferences(t)}
        <div class="msg-meta">${done || failed ? agentName : processing ? agentName : '等待执行'} · ${fmtTime(t.completed_at || t.progress_at || t.created_at)}</div>
      </div>
    </div>`;
  }).join('')}</div>`;

  // 点击气泡/状态条 → 打开任务详情抽屉
  flow.querySelectorAll('[data-task]').forEach((b) => {
    b.addEventListener('click', () => openTaskDrawer(b.dataset.task, { agents: state.agents, onRefresh: () => loadMessages(el, ctx) }));
  });
  // 绑定 artifacts 卡片交互
  bindArtifactCards(flow);
  // 绑定重试/改派按钮
  flow.querySelectorAll('.btn-retry').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      retryTask(el, ctx, btn.dataset.task);
    });
  });
  flow.querySelectorAll('.btn-reassign').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      reassignTask(el, ctx, btn.dataset.task);
    });
  });
  // 绑定 evidence 折叠条
  flow.querySelectorAll('.evidence-summary').forEach((s) => {
    s.addEventListener('click', () => {
      const body = s.nextElementSibling;
      if (!body) return;
      const isOpen = body.style.display === 'block';
      body.style.display = isOpen ? 'none' : 'block';
      s.setAttribute('data-open', String(!isOpen));
    });
  });
  // 绑定知识库参考折叠条
  flow.querySelectorAll('.kb-ref-summary').forEach((s) => {
    s.addEventListener('click', () => {
      const body = document.getElementById(s.dataset.rid);
      if (!body) return;
      const isOpen = body.style.display === 'block';
      body.style.display = isOpen ? 'none' : 'block';
      s.setAttribute('data-open', String(!isOpen));
    });
  });
  if (atBottom || !keepScroll) flow.scrollTop = flow.scrollHeight;
}

function buildEvidenceBar(t) {
  const ev = t.result?.evidence || t.evidence;
  if (!ev || typeof ev !== 'object') return '';
  const counts = [];
  const exec = Array.isArray(ev.executed_commands) ? ev.executed_commands.length : 0;
  const files = Array.isArray(ev.read_files) ? ev.read_files.length : 0;
  const searches = Array.isArray(ev.searches) ? ev.searches.length : 0;
  const tools = Array.isArray(ev.tool_calls) ? ev.tool_calls.length : 0;
  if (exec) counts.push(`${exec} 条命令`);
  if (files) counts.push(`${files} 个文件`);
  if (searches) counts.push(`${searches} 次搜索`);
  if (tools) counts.push(`${tools} 次工具调用`);
  const thinking = ev.thinking ? String(ev.thinking).trim() : '';
  if (!counts.length && !thinking) return '';
  const total = exec + files + searches + tools;
  const summary = total ? `查看执行过程（${counts.join(' / ')}）` : `查看思考过程`;
  const evId = 'ev-' + (t.id || Math.random().toString(36).slice(2, 8));
  const detail = [
    exec ? `<div class="evidence-section"><div class="evidence-title">已执行命令（${exec}）</div>${ev.executed_commands.map((c) => `<div class="evidence-item"><code>${escapeHtml(String(c))}</code></div>`).join('')}</div>` : '',
    files ? `<div class="evidence-section"><div class="evidence-title">读取文件（${files}）</div>${ev.read_files.map((f) => `<div class="evidence-item"><code>${escapeHtml(String(f))}</code></div>`).join('')}</div>` : '',
    searches ? `<div class="evidence-section"><div class="evidence-title">搜索关键词（${searches}）</div>${ev.searches.map((s) => `<div class="evidence-item">${escapeHtml(String(s))}</div>`).join('')}</div>` : '',
    tools ? `<div class="evidence-section"><div class="evidence-title">工具调用（${tools}）</div>${ev.tool_calls.map((x) => `<div class="evidence-item"><pre>${escapeHtml(JSON.stringify(x, null, 2))}</pre></div>`).join('')}</div>` : '',
    thinking ? `<div class="evidence-section"><div class="evidence-title">思考过程</div><div class="evidence-thinking">${renderMarkdown(thinking)}</div></div>` : '',
  ].filter(Boolean).join('');
  return `
    <div class="evidence-summary" data-open="false" data-evid="${evId}">
      <span class="evidence-icon">🔍</span>
      <span class="evidence-text">${summary}</span>
      <span class="evidence-chevron">▶</span>
    </div>
    <div class="evidence-body" id="${evId}" style="display:none">${detail}</div>`;
}

async function sendMessage(el, ctx) {
  if (state.sending) return;
  const input = el.querySelector('#chatInput');
  let content = input.value.trim();
  if (!content) return;
  if (!state.current) { toast('请先选择会话', 'error'); return; }

  // 快捷指令 /prompt /workflow /kb
  if (content.startsWith('/prompt ')) {
    input.value = '';
    return usePrompt(el, ctx, content.slice('/prompt '.length).trim());
  }
  if (content.startsWith('/workflow ')) {
    input.value = '';
    return useWorkflow(el, ctx, content.slice('/workflow '.length).trim());
  }
  if (content.startsWith('/kb ')) {
    input.value = '';
    return useKb(el, ctx, content.slice('/kb '.length).trim());
  }

  // 随手记指令：记一下：xxx 或 /note xxx → 不建任务，直接存知识库
  let noteContent = '';
  if (content.startsWith('记一下：') || content.startsWith('记一下:')) {
    noteContent = content.slice(content.indexOf('：') + 1).trim();
  } else if (content.startsWith('/note ')) {
    noteContent = content.slice('/note '.length).trim();
  }
  if (noteContent) {
    input.value = '';
    try {
      const item = await api.post('/api/kb/items/quick-note', { content: noteContent });
      // 直接在消息流追加用户消息 + 系统确认（不建任务，不入会话历史）
      appendNoteMessages(el, content, item);
      toast('已记入知识库「随手记」', 'success');
    } catch (err) { toast(err.message, 'error'); }
    input.focus();
    return;
  }

  // @ 指派智能体
  const { text, target } = parseAgentMention(content);
  if (target) {
    const select = el.querySelector('#chatTarget');
    select.value = target;
    content = text;
  }

  state.sending = true;
  const btn = el.querySelector('#chatSend');
  btn.disabled = true;
  input.value = '';
  try {
    const target = el.querySelector('#chatTarget').value;
    const body = { session_id: state.current, content };
    if (target) body.target_agent = target;
    const { task } = await api.post('/api/chat', body);
    showRouteHint(el, task);
    await loadMessages(el, ctx);
    pollTask(el, ctx, task.id);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.sending = false;
    btn.disabled = false;
    input.focus();
  }
}

function parseAgentMention(content) {
  const match = content.match(/^\s*@(\S+)(?:\s+|$)/);
  if (!match) return { text: content, target: null };
  const name = match[1];
  const agent = state.agents.find((a) => a.review_status === 'active' && a.name === name);
  if (!agent) {
    toast(`未找到智能体「${escapeHtml(name)}」`, 'error');
    return { text: content, target: null };
  }
  return { text: content.replace(/^\s*@\S+\s*/, '').trim(), target: agent.id };
}

async function updateInputHint(el) {
  const input = el.querySelector('#chatInput');
  const hint = el.querySelector('#chatHint');
  const routeHint = el.querySelector('#routeHint');
  routeHint.style.display = 'none';
  const val = input.value;
  const leading = val.match(/^\s*([/@][^\s]*)?/);
  const prefix = leading?.[1] || '';
  let items = [];
  if (prefix.startsWith('/')) {
    items = [
      { type: 'cmd', text: '/prompt', desc: '使用提示词模板', run: 'prompt' },
      { type: 'cmd', text: '/workflow', desc: '触发工作流', run: 'workflow' },
      { type: 'cmd', text: '/kb', desc: '搜索知识库', run: 'kb' },
      { type: 'cmd', text: '/note', desc: '随手记到知识库', run: 'note' },
    ].filter((c) => c.text.includes(prefix));
  } else if (prefix.startsWith('@')) {
    const name = prefix.slice(1).toLowerCase();
    items = state.agents
      .filter((a) => a.review_status === 'active' && a.name.toLowerCase().includes(name))
      .map((a) => ({ type: 'agent', text: `@${a.name}`, id: a.id, desc: a.name }));
  }
  if (!items.length) {
    hint.style.display = 'none';
    return;
  }
  hint.innerHTML = items.map((it) => `
    <div class="chat-hint-item" data-type="${it.type}" data-run="${it.run || ''}" data-id="${it.id || ''}" data-text="${escapeHtml(it.text)}">
      <span class="chat-hint-text">${escapeHtml(it.text)}</span>
      <span class="chat-hint-desc">${escapeHtml(it.desc)}</span>
    </div>`).join('');
  hint.style.display = 'block';
  hint.querySelectorAll('.chat-hint-item').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const type = item.dataset.type;
      const text = item.dataset.text;
      if (type === 'cmd') {
        input.value = text + ' ';
        updateInputHint(el);
      } else if (type === 'agent') {
        input.value = text + ' ' + val.replace(/^\s*@[^\s]*/, '').trim();
        hint.style.display = 'none';
      }
      input.focus();
    });
  });
}

/** 随手记指令：在消息流追加用户消息 + 系统确认气泡（不建任务） */
function appendNoteMessages(el, userContent, item) {
  const flow = el.querySelector('#msgFlow');
  if (!flow) return;
  // 清除空状态
  const empty = flow.querySelector('.empty-state');
  if (empty) empty.remove();
  const ts = fmtTime(Math.floor(Date.now() / 1000));
  const userHtml = `
    <div class="msg-row user">
      <div>
        <div class="msg-bubble">${escapeHtml(userContent)}</div>
        <div class="msg-meta" style="text-align:right">我 · ${ts}</div>
      </div>
    </div>`;
  const botHtml = `
    <div class="msg-row sys">
      <div>
        <div class="msg-bubble">📝 已记入知识库「随手记」${item?.id ? `（<a href="#/kb" style="color:var(--accent)" data-kb-item="${item.id}">可点查看条目</a>）` : ''}</div>
        <div class="msg-meta">系统 · ${ts}</div>
      </div>
    </div>`;
  flow.insertAdjacentHTML('beforeend', userHtml + botHtml);
  flow.scrollTop = flow.scrollHeight;
  // 点击「查看条目」跳转知识库
  const link = flow.querySelector(`[data-kb-item="${item?.id}"]`);
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.hash = '#/kb';
      setTimeout(() => window.dispatchEvent(new CustomEvent('open-kb-item', { detail: item.id })), 300);
    });
  }
}

function showRouteHint(el, task) {
  const route = task?.extra?.route;
  const box = el.querySelector('#routeHint');
  if (!route || route.by === 'manual') {
    box.style.display = 'none';
    return;
  }
  const agentName = route.target_agent
    ? escapeHtml(state.agents.find((a) => a.id === route.target_agent)?.name || route.target_agent)
    : route.required_capability ? `能力「${escapeHtml(route.required_capability)}」` : '自动抢单';
  const byText = route.by === 'ai' ? '🤖 AI 已派单' : '↪ 系统派单';
  box.innerHTML = `${byText}：已派给 ${agentName}${route.reason ? `（${escapeHtml(route.reason)}）` : ''}`;
  box.style.display = 'block';
  setTimeout(() => { box.style.display = 'none'; }, 8000);
}

function renderKbReferences(t) {
  const ev = t.result?.evidence || t.evidence;
  if (!ev || typeof ev !== 'object') return '';
  const searches = Array.isArray(ev.searches) ? ev.searches : [];
  if (!searches.length) return '';
  const rid = 'kbr-' + (t.id || Math.random().toString(36).slice(2, 8));
  const queries = searches.map((s) => {
    const q = typeof s === 'string' ? s : (s?.query || '');
    const hits = typeof s === 'object' && s !== null ? (s.hits ?? '?') : '?';
    return { q, hits };
  });
  return `
    <div class="kb-ref-summary" data-open="false" data-rid="${rid}">
      <span>🔍 参考了知识库（${queries.length} 条）</span>
      <span class="kb-ref-chevron">▶</span>
    </div>
    <div class="kb-ref-body" id="${rid}" style="display:none">
      ${queries.map((x) => `<div class="kb-ref-item">「${escapeHtml(x.q)}」（命中 ${x.hits} 条）</div>`).join('')}
    </div>`;
}

async function usePrompt(el, ctx, keyword) {
  let list;
  try {
    list = await api.get('/api/prompts');
  } catch (err) { toast(err.message, 'error'); return; }
  const matches = list.filter((p) => !keyword || p.name.includes(keyword) || (p.category || '').includes(keyword));
  if (!matches.length) { toast('未找到匹配的提示词模板', 'error'); return; }
  const p = matches[0];
  if (!p.variables?.length) {
    return submitPrompt(el, ctx, p.id, {});
  }
  openModal({
    title: `使用提示词：${p.name}`,
    body: p.variables.map((v) => `
      <label class="field">
        <span>${escapeHtml(v)}</span>
        <input type="text" class="prompt-var-input" data-var="${escapeHtml(v)}" placeholder="请输入 ${escapeHtml(v)}">
      </label>`).join(''),
    okText: '生 成',
    onOk: async (modal) => {
      const vars = {};
      modal.querySelectorAll('.prompt-var-input').forEach((input) => {
        vars[input.dataset.var] = input.value;
      });
      await submitPrompt(el, ctx, p.id, vars);
    },
  });
}

async function submitPrompt(el, ctx, promptId, vars) {
  const r = await api.post(`/api/prompts/${promptId}/use`, {
    vars,
    session_id: state.current,
  });
  await loadMessages(el, ctx);
  if (r.task?.id) pollTask(el, ctx, r.task.id);
}

async function useWorkflow(el, ctx, keyword) {
  let list;
  try {
    list = await api.get('/api/workflows');
  } catch (err) { toast(err.message, 'error'); return; }
  const matches = list.filter((w) => !keyword || w.name.includes(keyword) || (w.description || '').includes(keyword));
  if (!matches.length) { toast('未找到匹配的工作流', 'error'); return; }
  const w = matches[0];
  const r = await api.post(`/api/workflows/${w.id}/execute`, { name: w.name });
  const run = r;
  await api.post(`/api/chat/${state.current}/messages`, {
    content: `已触发工作流：${w.name}（run-id：${run.id}）`,
    source: 'system',
  });
  await loadMessages(el, ctx);
  toast('工作流已触发', 'success');
}

async function useKb(el, ctx, query) {
  let r;
  try {
    r = await api.post('/api/kb/search', { q: query, limit: 5 });
  } catch (err) { toast(err.message, 'error'); return; }
  const items = r.results || [];
  const answer = items.length
    ? `🔍 知识库搜索结果：\n\n${items.map((it, i) => `${i + 1}. **${it.title}**\n${it.content}`).join('\n\n')}`
    : '未在知识库中找到相关内容。';
  await api.post(`/api/chat/${state.current}/messages`, {
    content: answer,
    source: 'kb',
  });
  await loadMessages(el, ctx);
}

async function retryTask(el, ctx, taskId) {
  try {
    const r = await api.post('/api/chat/retry', { task_id: taskId, session_id: state.current });
    await loadMessages(el, ctx);
    pollTask(el, ctx, r.task.id);
    toast('已重试', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function reassignTask(el, ctx, taskId) {
  const agents = state.agents.filter((a) => a.review_status === 'active');
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
      const r = await api.post('/api/chat/reassign', {
        task_id: taskId,
        new_agent_id: newAgentId,
        session_id: state.current,
      });
      await loadMessages(el, ctx);
      pollTask(el, ctx, r.task.id);
      toast('已改派', 'success');
    },
  });
}

/** 每 2s 轮询任务状态，直到 completed/failed，然后回填 */
function pollTask(el, ctx, taskId, count = 0) {
  const timer = setTimeout(async () => {
    if (!el.isConnected) return;
    try {
      const t = await api.get(`/api/tasks/${taskId}`);
      if (t.status === 'completed' || t.status === 'failed') {
        await loadMessages(el, ctx);
        toast(t.status === 'completed' ? '智能体已回复' : '任务执行失败', t.status === 'completed' ? 'success' : 'error');
        return;
      }
      // 每 5 次轮询刷新一次消息流，展示状态变化
      if (count % 5 === 4) await loadMessages(el, ctx);
      pollTask(el, ctx, taskId, count + 1);
    } catch {
      if (count > 5) return; // 网络异常时有限重试
      pollTask(el, ctx, taskId, count + 1);
    }
  }, 2000);
  ctx.onCleanup(() => clearTimeout(timer));
}
