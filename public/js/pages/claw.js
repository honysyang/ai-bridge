/* ============================================================
   pages/claw.js — 消息通信：连接（状态机）｜ 联系人 ｜ 推送订阅 ｜ 会话消息
   ============================================================ */
import {
  api, toast, escapeHtml, safeText, fmtTime, truncate, emptyHTML, openModal,
  confirmBox, SOURCE_MAP, statusBadge,
} from '../api.js';

let contactsCache = [];
let groupsCache = [];

function contactName(wxid) {
  const c = contactsCache.find((x) => x.wxid === wxid);
  return c ? `${c.name}（${c.wxid}）` : wxid;
}

function contactOption(wxid) {
  const c = contactsCache.find((x) => x.wxid === wxid);
  return c ? `${escapeHtml(c.name)} ${c.type === 'room' ? '👥' : '👤'}` : escapeHtml(wxid);
}

/** 相对时间（用于会话列表/工作台「最近」） */
function relTime(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return fmtTime(ts, false);
}

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="conn">连接</div>
      <div class="tab" data-tab="contacts">联系人</div>
      <div class="tab" data-tab="push">推送订阅</div>
      <div class="tab" data-tab="msgs">会话消息</div>
    </div>
    <div id="tabBody"><div class="loading-line"><span class="spinner"></span> 加载中…</div></div>`;
  const body = el.querySelector('#tabBody');
  const renderTab = (tab) => {
    el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'conn') renderConn(body, ctx);
    else if (tab === 'contacts') renderContacts(body);
    else if (tab === 'push') renderPush(body);
    else renderMessages(body, ctx);
  };
  el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => renderTab(t.dataset.tab)));
  try {
    contactsCache = await api.get('/api/claw/contacts');
    groupsCache = await api.get('/api/claw/contacts/groups');
  } catch { contactsCache = []; groupsCache = []; }
  renderTab('conn');
}

/* ==================== 连接（状态机重做） ==================== */
async function renderConn(box, ctx) {
  let st;
  try { st = await api.get('/api/claw/status'); } catch (e) {
    box.innerHTML = emptyHTML('📡', '状态加载失败', e.message);
    return;
  }
  const isMockMode = !!st.mock;

  box.innerHTML = `
    ${isMockMode ? `<div class="claw-mode-banner"><span class="claw-mode-tag">MOCK</span> 演示模式 · 内置 mock 适配器，不连接真实微信。生成的二维码与消息均为模拟。</div>` : ''}

    <div class="card">
      <div class="card-title">📡 连接状态 ${isMockMode ? '<span class="badge badge-yellow">mock 适配器</span>' : '<span class="badge badge-blue">iLink Bot</span>'}</div>
      <div id="connStateCard"></div>
      <div class="mt16">
        <button class="btn btn-sm" id="btnDiagnose">🔍 连接诊断</button>
        <div id="diagBox" class="mt8" style="display:none"></div>
      </div>
    </div>

    <div id="qrArea"></div>

    ${!isMockMode ? `
    <details class="claw-cred-panel">
      <summary>🔑 iLink 凭证管理（管理员）</summary>
      <div id="credBox" class="mt8" style="font-size:12px;line-height:1.7">加载中…</div>
      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-size:12px;color:var(--text-light)">手动写入凭证（高级）</summary>
        <div style="margin-top:8px">
          <label class="field"><span>ILINK_BASE_URL</span><input type="text" id="credBase" placeholder="https://ilinkai.weixin.qq.com"></label>
          <label class="field"><span>ILINK_BOT_TOKEN *</span><input type="text" id="credToken" placeholder="扫码后由平台返回的 token"></label>
          <label class="field"><span>ILINK_BOT_ID *</span><input type="text" id="credBotId" placeholder="如：bot_xxxxx"></label>
          <label class="field"><span>ILINK_USER_ID *</span><input type="text" id="credUserId" placeholder="如：oWxxxxxx"></label>
          <div class="row-actions">
            <button class="btn btn-sm btn-primary" id="btnSaveCred">💾 保存并启动 adapter</button>
            <button class="btn btn-sm btn-danger" id="btnClearCred">🗑️ 清除凭证</button>
          </div>
        </div>
      </details>
    </details>` : ''}

    ${isMockMode ? `
    <div class="card claw-mock-form mt16">
      <h4>📲 模拟收到微信消息</h4>
      <p class="section-desc">选择联系人并填写内容，提交后将生成一条「微信」来源任务，由智能体处理并自动回复。<br>群消息需以 <code>/ai </code> 或 <code>@机器人</code> 开头才会建任务（用于测试群聊触发）。</p>
      <label class="field"><span>发送人（联系人 / 群）</span>
        <select id="mockWxid">
          ${contactsCache.map((c) => `<option value="${c.wxid}">${escapeHtml(c.name)} ${c.type === 'room' ? '👥' : '👤'}</option>`).join('')}
        </select></label>
      <div class="form-row">
        <label class="field"><span>是否群消息</span>
          <select id="mockIsRoom">
            <option value="0">👤 私聊</option>
            <option value="1">👥 群消息（需前缀）</option>
          </select></label>
        <label class="field"><span>消息内容</span><input type="text" id="mockContent" placeholder="如：帮我查一下昨天的任务成功率"></label>
      </div>
      <button class="btn btn-primary btn-block" id="mockSend">📩 模拟收到消息 → 创建任务</button>
      <div id="mockResult" class="mt8"></div>
    </div>` : ''}
  `;

  // 渲染状态卡 + 二维码区
  function renderStateCard(s) {
    const holder = box.querySelector('#connStateCard');
    const qrArea = box.querySelector('#qrArea');
    if (!holder || !qrArea) return;
    const state = s.mock ? (s.connected ? 'connected' : (s.state === 'qrcode' ? 'qrcode' : 'disconnected')) : s.state;
    const stateMap = {
      disconnected: { icon: '⚫', title: '未连接', sub: isMockMode ? '点击「生成演示二维码」开始演示登录流程' : '点击「扫码登录」开始', cls: 'is-disconnected' },
      qrcode: { icon: '📱', title: '等待扫码', sub: isMockMode ? '请用手机相机/扫码 app 扫描下方二维码完成演示登录' : '请使用微信扫描下方二维码', cls: 'is-qrcode' },
      connected: { icon: '✅', title: '已连接', sub: isMockMode ? '演示连接已建立，模拟消息会自动入队' : '真实微信消息自动入队', cls: 'is-connected' },
      reconnecting: { icon: '🔄', title: '重连中…', sub: '正在尝试恢复连接', cls: 'is-error' },
    };
    const info = stateMap[state] || stateMap.disconnected;
    const connectedDuration = s.connectedAt ? relTime(Math.floor(s.connectedAt / 1000)) : '';
    holder.innerHTML = `
      <div class="claw-state-card ${info.cls}">
        <div class="claw-state-icon">${info.icon}</div>
        <div class="claw-state-body">
          <div class="state-title">${info.title}</div>
          <div class="state-sub">${info.sub}</div>
          ${s.account ? `<div class="state-account">账号：${escapeHtml(s.account)}</div>` : ''}
          ${s.error ? `<div class="state-account" style="color:var(--red)">错误：${escapeHtml(s.error)}</div>` : ''}
          ${state === 'connected' && connectedDuration ? `<div class="state-account">连接时长：${connectedDuration}</div>` : ''}
        </div>
        <div class="claw-state-actions">
          ${state === 'disconnected' ? `<button class="btn btn-green" id="btnLogin">${isMockMode ? '📷 生成演示二维码' : '📷 开始扫码登录'}</button>` : ''}
          ${state === 'qrcode' ? `<button class="btn" id="btnLogin">🔄 刷新二维码</button>` : ''}
          ${state === 'connected' ? `
            <button class="btn btn-danger" id="btnLogout">退出登录</button>
            ${!isMockMode ? '<button class="btn" id="btnRestart">↻ 重启连接</button>' : ''}
          ` : ''}
          ${state === 'reconnecting' || s.error ? `<button class="btn btn-green" id="btnLogin">📷 重新扫码</button>` : ''}
          ${isMockMode && state !== 'connected' ? '<button class="btn btn-sm" id="btnMockConnect" title="跳过二维码，直接建立 mock 连接">⚡ 跳过扫码直接连接</button>' : ''}
        </div>
      </div>`;

    // 二维码区
    if (state === 'qrcode') {
      const expired = s.qrcodeExpiresAt && (Number(s.qrcodeExpiresAt) < Date.now());
      qrArea.innerHTML = `
        <div class="claw-qr-large" id="qrLarge">
          ${expired
            ? `<div style="padding:60px 0"><div style="font-size:48px">⏰</div><p class="qr-expired" id="qrRefresh">二维码已过期，点击刷新</p></div>`
            : '<div class="faint" style="padding:40px 0"><span class="spinner"></span> 加载二维码…</div>'}
        </div>
        <div class="claw-scan-steps">
          <div class="claw-scan-step"><span class="step-num">1</span>打开微信「扫一扫」</div>
          <div class="claw-scan-step"><span class="step-num">2</span>对准上方二维码扫描</div>
          <div class="claw-scan-step"><span class="step-num">3</span>手机点击「确认登录」</div>
        </div>`;
      if (!expired) loadQrImage();
      qrArea.querySelector('#qrRefresh')?.addEventListener('click', async () => {
        try { await api.post('/api/claw/login/start'); toast('已触发刷新', 'success'); setTimeout(loadStatus, 500); }
        catch (err) { toast(err.message, 'error'); }
      });
    } else if (state === 'connected') {
      qrArea.innerHTML = '';
    } else {
      qrArea.innerHTML = '';
    }

    // 绑定状态卡按钮
    holder.querySelector('#btnLogin')?.addEventListener('click', async () => {
      try {
        if (isMockMode) {
          const r = await api.post('/api/claw/login/start');
          if (r.connected) { toast('已建立 mock 连接', 'success'); }
          else { toast('演示二维码已生成，请用扫码 app 扫一下', 'success'); }
        } else {
          await api.post('/api/claw/login/start');
          toast('已触发扫码流程', 'success');
        }
        setTimeout(loadStatus, 400);
      } catch (err) { toast(err.message, 'error'); }
    });
    holder.querySelector('#btnLogout')?.addEventListener('click', async () => {
      try {
        if (isMockMode) await api.post('/api/claw/mock/disconnect');
        else await api.post('/api/claw/logout');
        toast('已退出', 'success');
        loadStatus(); loadCred();
      } catch (err) { toast(err.message, 'error'); }
    });
    holder.querySelector('#btnRestart')?.addEventListener('click', async () => {
      try { await api.post('/api/claw/restart'); toast('已重启', 'success'); setTimeout(loadStatus, 1000); }
      catch (err) { toast(err.message, 'error'); }
    });
    holder.querySelector('#btnMockConnect')?.addEventListener('click', async () => {
      try {
        const r = await api.post('/api/claw/mock/connect');
        toast('已建立 mock 连接：' + (r.account || ''), 'success');
        loadStatus();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  async function loadQrImage() {
    const qrLarge = box.querySelector('#qrLarge');
    if (!qrLarge) return;
    try {
      const url = await api.blobUrl('/api/claw/qrcode.png?t=' + Date.now(), 'image/png');
      if (!box.isConnected) return;
      qrLarge.innerHTML = `<img src="${url}" alt="微信登录二维码"><p class="qr-tip">${isMockMode ? '🧪 演示二维码：用手机相机/任意扫码 app 扫一下即可触发模拟登录确认' : '二维码 3 分钟内有效，微信扫码后会自动连接'}</p>`;
    } catch (e) {
      qrLarge.innerHTML = `<div class="faint" style="padding:40px 0">二维码加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  async function loadStatus() {
    if (!box.isConnected) return;
    try {
      st = await api.get('/api/claw/status');
      if (!box.isConnected) return;
      renderStateCard(st);
    } catch (err) {
      const holder = box.querySelector('#connStateCard');
      if (holder) holder.innerHTML = emptyHTML('📡', '状态加载失败', err.message);
    }
  }

  async function loadCred() {
    if (isMockMode) return;
    const cbox = box.querySelector('#credBox');
    if (!cbox) return;
    try {
      const c = await api.get('/api/claw/credentials');
      cbox.innerHTML = `
        <div class="cred-row">ILINK_BASE_URL：<b>${escapeHtml(c.ILINK_BASE_URL || '（默认）')}</b></div>
        <div class="cred-row">ILINK_BOT_ID：<b>${escapeHtml(c.ILINK_BOT_ID || '—')}</b></div>
        <div class="cred-row">ILINK_USER_ID：<b>${escapeHtml(c.ILINK_USER_ID || '—')}</b></div>
        <div class="cred-row">ILINK_BOT_TOKEN：${c.has_token ? '<span class="badge badge-green">已设置</span>' : '<span class="badge badge-red">未设置</span>'}</div>
        ${c.ILINK_APP_ID ? `<div class="cred-row">ILINK_APP_ID：<b>${escapeHtml(c.ILINK_APP_ID)}</b></div>` : ''}
      `;
    } catch (e) {
      cbox.innerHTML = `<div class="faint">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runDiagnose() {
    const diagBox = box.querySelector('#diagBox');
    if (!diagBox) return;
    diagBox.style.display = 'block';
    diagBox.innerHTML = '<div class="faint"><span class="spinner"></span> 诊断中…</div>';
    try {
      const d = await api.post('/api/claw/diagnose');
      const rows = d.checks.map((c) => `
        <div class="flex mb4" style="align-items:flex-start;gap:8px">
          <span style="font-size:16px">${c.ok ? '✅' : '❌'}</span>
          <div>
            <div style="font-weight:600;font-size:13px">${escapeHtml(c.name)}</div>
            <div class="faint" style="font-size:12px">${escapeHtml(c.detail)}</div>
          </div>
        </div>`).join('');
      diagBox.innerHTML = `
        <div class="card" style="box-shadow:none;background:${d.ok ? 'var(--green-soft)' : 'var(--red-soft)'};border-color:${d.ok ? '#dde6cc' : '#eccfc6'};padding:12px 14px">
          <div class="mb8" style="font-weight:700">${d.ok ? '连接诊断通过' : '连接诊断未通过'}</div>
          ${rows}
        </div>`;
    } catch (e) {
      diagBox.innerHTML = `<div class="faint">诊断失败：${escapeHtml(e.message)}</div>`;
    }
  }

  await loadStatus();
  await loadCred();

  // qrcode/reconnecting 状态下每 2s 轮询推进
  const statusTimer = setInterval(() => {
    if (!box.isConnected) return;
    if (isMockMode) {
      if (st?.state === 'qrcode' || !st?.connected) loadStatus();
    } else if (st?.state === 'qrcode' || st?.state === 'reconnecting') {
      loadStatus();
    }
  }, 2000);
  ctx.onCleanup(() => clearInterval(statusTimer));

  box.querySelector('#btnDiagnose').addEventListener('click', runDiagnose);
  box.querySelector('#btnSaveCred')?.addEventListener('click', async () => {
    const body = {
      ILINK_BASE_URL: box.querySelector('#credBase').value.trim() || undefined,
      ILINK_BOT_TOKEN: box.querySelector('#credToken').value.trim(),
      ILINK_BOT_ID: box.querySelector('#credBotId').value.trim(),
      ILINK_USER_ID: box.querySelector('#credUserId').value.trim(),
    };
    if (!body.ILINK_BOT_TOKEN || !body.ILINK_BOT_ID || !body.ILINK_USER_ID) {
      toast('请填写所有必填项', 'error'); return;
    }
    try {
      await api.post('/api/claw/credentials', body);
      toast('凭证已保存并启动 adapter', 'success');
      setTimeout(() => { loadStatus(); loadCred(); }, 1500);
    } catch (err) { toast(err.message, 'error'); }
  });
  box.querySelector('#btnClearCred')?.addEventListener('click', () => {
    confirmBox('确定清除 iLink 凭证？清除后需要重新扫码登录。', async () => {
      try {
        await api.del('/api/claw/credentials');
        toast('凭证已清除', 'success');
        loadStatus(); loadCred();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  if (isMockMode) {
    box.querySelector('#mockSend')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const wxid = box.querySelector('#mockWxid').value;
      const content = box.querySelector('#mockContent').value.trim();
      const isRoom = box.querySelector('#mockIsRoom').value === '1';
      if (!content) { toast('请填写消息内容', 'error'); return; }
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 创建任务中…';
      try {
        const r = await api.post('/api/claw/mock/incoming', { wxid, content, isRoom });
        const result = box.querySelector('#mockResult');
        if (r.task) {
          result.innerHTML = `
            <div class="card" style="box-shadow:none;margin:0;background:var(--green-soft);border-color:#dde6cc">
              ✅ 已生成任务 <span class="mono">${escapeHtml(r.task.id)}</span> ${statusBadge(r.task.status)}
              <div class="mt8"><a href="#/tasks">→ 前往任务中心跟踪执行</a></div>
            </div>`;
          box.querySelector('#mockContent').value = '';
          toast('模拟消息已接收并生成任务', 'success');
        } else if (r.reason === 'no_trigger') {
          result.innerHTML = `
            <div class="card" style="box-shadow:none;margin:0;background:var(--yellow-soft);border-color:#ecdfc0">
              ⚠️ 群消息未以 <code>/ai </code> 或 <code>@机器人</code> 开头，未建任务（仅留痕）
            </div>`;
          toast('群消息无触发前缀，未建任务', 'info');
        }
      } catch (err) { toast(err.message, 'error'); }
      finally {
        btn.disabled = false;
        btn.innerHTML = '📩 模拟收到消息 → 创建任务';
      }
    });
  }
}

/* ==================== 联系人 ==================== */
async function renderContacts(box) {
  let filterQ = '';
  let filterGroup = '';
  let filterType = '';

  function renderToolbar() {
    return `
      <div class="card">
        <div class="flex-between" style="gap:12px;flex-wrap:wrap">
          <div class="flex" style="gap:8px;flex-wrap:wrap">
            <input type="text" id="cSearch" class="input" placeholder="搜索名称 / wxid" value="${escapeHtml(filterQ)}" style="min-width:200px">
            <select id="cGroup" class="input" style="min-width:120px">
              <option value="">所有分组</option>
              ${groupsCache.map((g) => `<option value="${escapeHtml(g.name)}" ${filterGroup === g.name ? 'selected' : ''}>${escapeHtml(g.name)} (${g.count})</option>`).join('')}
            </select>
            <select id="cType" class="input" style="min-width:100px">
              <option value="">全部类型</option>
              <option value="friend" ${filterType === 'friend' ? 'selected' : ''}>👤 好友</option>
              <option value="room" ${filterType === 'room' ? 'selected' : ''}>👥 群聊</option>
            </select>
            <button class="btn" id="cSearchBtn">🔍 搜索</button>
            <button class="btn btn-ghost" id="cReset">重置</button>
          </div>
          <div class="flex" style="gap:8px">
            <button class="btn btn-green" id="cAdd">＋ 添加联系人</button>
          </div>
        </div>
      </div>`;
  }

  box.innerHTML = `${renderToolbar()}
    <div class="card">
      <div id="cBody"><div class="loading-line"><span class="spinner"></span> 加载联系人…</div></div>
    </div>`;

  async function refreshGroups() {
    try { groupsCache = await api.get('/api/claw/contacts/groups'); } catch { groupsCache = []; }
    const select = box.querySelector('#cGroup');
    if (!select) return;
    const cur = select.value;
    select.innerHTML = `<option value="">所有分组</option>${groupsCache.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${g.count})</option>`).join('')}`;
    select.value = cur || '';
  }

  async function load() {
    if (!box.isConnected) return;
    const holder = box.querySelector('#cBody');
    if (!holder) return;
    let statsMap = new Map();
    try {
      const stats = await api.get('/api/claw/contacts/stats');
      statsMap = new Map(stats.map((s) => [s.wxid, s]));
    } catch { /* ignore */ }
    try {
      const params = new URLSearchParams();
      if (filterQ) params.set('q', filterQ);
      if (filterGroup) params.set('group', filterGroup);
      if (filterType) params.set('type', filterType);
      contactsCache = await api.get(`/api/claw/contacts?${params.toString()}`);
      await refreshGroups();
    } catch (err) {
      if (!box.isConnected || !holder) return;
      holder.innerHTML = emptyHTML('👥', '联系人加载失败', err.message);
      return;
    }
    if (!box.isConnected || !holder) return;
    if (!contactsCache.length) {
      holder.innerHTML = emptyHTML('👥', '暂无联系人', '点击「添加联系人」加入，或等待微信消息自动累积');
      return;
    }
    holder.innerHTML = `<table class="table">
      <thead><tr><th>名称</th><th>wxid</th><th>类型</th><th>分组</th><th>消息统计</th><th>备注</th><th>操作</th></tr></thead>
      <tbody>${contactsCache.map((c) => {
        const st = statsMap.get(c.wxid) || { count: 0, last_at: 0, unread: 0 };
        return `
        <tr data-id="${c.id}">
          <td>${c.type === 'room' ? '👥' : '👤'} ${escapeHtml(c.name)}</td>
          <td class="mono faint">${escapeHtml(c.wxid)}</td>
          <td>${c.type === 'room' ? '群聊' : '好友'}</td>
          <td>${escapeHtml(c.group || '未分组')}</td>
          <td>
            <div class="claw-contact-stats">
              <span class="stat-pill">${st.count} 条</span>
              ${st.unread > 0 ? `<span class="stat-pill unread">${st.unread} 未读</span>` : ''}
              ${st.last_at ? `<span class="stat-pill">${relTime(st.last_at)}</span>` : ''}
            </div>
          </td>
          <td class="faint">${escapeHtml(c.remark || '')}</td>
          <td><div class="row-actions">
            <button class="btn btn-sm btn-primary" data-send="${c.wxid}">✉️ 发消息</button>
            <button class="btn btn-sm" data-edit="${c.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-del="${c.id}">删除</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    holder.querySelectorAll('[data-send]').forEach((btn) => btn.addEventListener('click', () => openSendModal(btn.dataset.send, load)));
    holder.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openContactModal(contactsCache.find((x) => x.id === btn.dataset.edit), load)));
    holder.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => {
      const c = contactsCache.find((x) => x.id === btn.dataset.del);
      confirmBox(`确定删除联系人「${c?.name || ''}」吗？`, async () => {
        try { await api.del(`/api/claw/contacts/${c.id}`); toast('已删除', 'success'); load(); }
        catch (err) { toast(err.message, 'error'); }
      });
    }));
  }

  function doSearch() {
    filterQ = box.querySelector('#cSearch').value.trim();
    filterGroup = box.querySelector('#cGroup').value;
    filterType = box.querySelector('#cType').value;
    load();
  }

  box.querySelector('#cSearchBtn').addEventListener('click', doSearch);
  box.querySelector('#cSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  box.querySelector('#cGroup').addEventListener('change', doSearch);
  box.querySelector('#cType').addEventListener('change', doSearch);
  box.querySelector('#cReset').addEventListener('click', () => {
    filterQ = ''; filterGroup = ''; filterType = '';
    box.querySelector('#cSearch').value = '';
    box.querySelector('#cGroup').value = '';
    box.querySelector('#cType').value = '';
    load();
  });
  box.querySelector('#cAdd').addEventListener('click', () => openContactModal(null, load));

  load();
}

function openContactModal(contact, done) {
  const isEdit = !!contact;
  openModal({
    title: isEdit ? '编辑联系人' : '新增联系人',
    body: `
      <label class="field"><span>wxid *</span><input type="text" id="cWxid" value="${isEdit ? escapeHtml(contact.wxid) : ''}" placeholder="如：wxid_xxx 或 xxx@chatroom" ${isEdit ? 'disabled' : ''}></label>
      <label class="field"><span>名称 *</span><input type="text" id="cName" value="${isEdit ? escapeHtml(contact.name) : ''}" placeholder="显示名称"></label>
      <div class="form-row">
        <label class="field"><span>类型</span>
          <select id="cType">
            <option value="friend" ${(!isEdit || contact.type === 'friend') ? 'selected' : ''}>👤 好友</option>
            <option value="room" ${isEdit && contact.type === 'room' ? 'selected' : ''}>👥 群聊</option>
          </select></label>
        <label class="field"><span>分组</span><input type="text" id="cGroup" value="${isEdit ? escapeHtml(contact.group || '') : ''}" placeholder="如：同事"></label>
      </div>
      <label class="field"><span>备注</span><input type="text" id="cRemark" value="${isEdit ? escapeHtml(contact.remark || '') : ''}" placeholder="可选"></label>
    `,
    okText: '保 存',
    onOk: async (modal) => {
      const wxid = modal.querySelector('#cWxid').value.trim();
      const name = modal.querySelector('#cName').value.trim();
      const type = modal.querySelector('#cType').value;
      const group = modal.querySelector('#cGroup').value.trim() || '未分组';
      const remark = modal.querySelector('#cRemark').value.trim();
      if (!wxid || !name) { toast('wxid 和名称为必填', 'error'); return false; }
      try {
        if (isEdit) {
          await api.patch(`/api/claw/contacts/${contact.id}`, { name, type, group, remark });
        } else {
          await api.post('/api/claw/contacts', { wxid, name, type, group, remark });
        }
        toast('已保存', 'success');
        if (done) done();
      } catch (err) { toast(err.message, 'error'); return false; }
    },
  });
}

function openSendModal(wxid, done) {
  openModal({
    title: `发消息给 ${contactName(wxid)}`,
    body: '<label class="field"><span>消息内容</span><textarea id="sendContent"></textarea></label>',
    okText: '发 送',
    onOk: async (modal) => {
      const content = modal.querySelector('#sendContent').value.trim();
      if (!content) { toast('请填写内容', 'error'); return false; }
      try {
        await api.post('/api/claw/send', { wxid, content });
        toast('消息已发送', 'success');
        if (done) done();
      } catch (err) { toast(err.message, 'error'); return false; }
    },
  });
}

/* ==================== 推送订阅 ==================== */
const EVENT_OPTS = [
  { v: 'accepted', label: '已接单' },
  { v: 'completed', label: '已完成' },
  { v: 'failed', label: '失败' },
];

async function renderPush(box) {
  box.innerHTML = `
    <div class="card">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">🔔 推送订阅规则
          <span class="sub">任务状态变化时，向目标联系人推送中文通知（真实 iLink 模式下会调用微信发消息）</span></div>
        <button class="btn btn-green" id="prNew">＋ 新建规则</button>
      </div>
      <div class="table-wrap" id="prTable"><div class="loading-line"><span class="spinner"></span> 加载规则…</div></div>
    </div>
    <div class="card">
      <div class="card-title">📤 推送记录（outbox）<span class="sub">含 event=reply 的自动回复记录</span></div>
      <div class="table-wrap" id="obTable"><div class="loading-line"><span class="spinner"></span> 加载记录…</div></div>
    </div>`;

  async function loadRules() {
    if (!box.isConnected) return;
    const table = box.querySelector('#prTable');
    if (!table) return;
    let rules;
    try { rules = await api.get('/api/claw/push-rules'); } catch (err) {
      if (!box.isConnected || !table) return;
      table.innerHTML = emptyHTML('🔔', '规则加载失败', err.message);
      return;
    }
    if (!box.isConnected || !table) return;
    if (!Array.isArray(rules) || !rules.length) {
      table.innerHTML = emptyHTML('🔔', '暂无推送规则', '点击「新建规则」，任务状态变化时自动通知联系人');
      return;
    }
    table.innerHTML = `<table class="table">
      <thead><tr><th>名称</th><th>事件</th><th>来源筛选</th><th>目标联系人</th><th>启用</th><th>操作</th></tr></thead>
      <tbody>${rules.map((r) => `
        <tr data-id="${r.id}">
          <td>${escapeHtml(r.name)}</td>
          <td>${(r.events || []).map((e) => `<span class="badge badge-blue">${escapeHtml(EVENT_OPTS.find((o) => o.v === e)?.label || e)}</span>`).join(' ')}</td>
          <td>${(r.source_filter || []).length ? r.source_filter.map((s) => `<span class="badge">${SOURCE_MAP[s]?.icon || ''}${SOURCE_MAP[s]?.text || s}</span>`).join(' ') : '<span class="faint">全部来源</span>'}</td>
          <td>${escapeHtml(contactName(r.target_wxid))}</td>
          <td><label class="switch"><input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}><span class="slider"></span></label></td>
          <td><div class="row-actions">
            <button class="btn btn-sm btn-primary" data-act="test">🧪 测试</button>
            <button class="btn btn-sm" data-act="edit">编辑</button>
            <button class="btn btn-sm btn-danger" data-act="del">删除</button>
          </div></td>
        </tr>`).join('')}</tbody></table>`;

    table.querySelectorAll('tr[data-id]').forEach((tr) => {
      const rule = rules.find((r) => r.id === tr.dataset.id);
      tr.querySelector('[data-act="toggle"]').addEventListener('change', async (e) => {
        try {
          await api.patch(`/api/claw/push-rules/${rule.id}`, { enabled: e.target.checked });
          toast(e.target.checked ? '已启用' : '已停用', 'success');
        } catch (err) { toast(err.message, 'error'); loadRules(); }
      });
      tr.querySelector('[data-act="test"]').addEventListener('click', async () => {
        try { await api.post(`/api/claw/push-rules/${rule.id}/test`); toast('测试推送已触发，请查看 outbox', 'success'); loadOutbox(); }
        catch (err) { toast(err.message, 'error'); }
      });
      tr.querySelector('[data-act="edit"]').addEventListener('click', () => openRuleModal(rule, () => { loadRules(); loadOutbox(); }));
      tr.querySelector('[data-act="del"]').addEventListener('click', () => {
        confirmBox(`确定删除推送规则「${rule.name}」吗？`, async () => {
          await api.del(`/api/claw/push-rules/${rule.id}`);
          toast('已删除', 'success');
          loadRules();
        });
      });
    });
  }

  async function loadOutbox() {
    if (!box.isConnected) return;
    const table = box.querySelector('#obTable');
    if (!table) return;
    let rows;
    try { rows = await api.get('/api/claw/outbox?limit=50'); } catch (err) {
      if (!box.isConnected || !table) return;
      table.innerHTML = emptyHTML('📤', '推送记录加载失败', err.message);
      return;
    }
    if (!box.isConnected || !table) return;
    if (!Array.isArray(rows) || !rows.length) {
      table.innerHTML = emptyHTML('📤', '暂无推送记录', '配置规则并触发任务状态变化后，这里会出现推送流水（含自动回复）');
      return;
    }
    const eventLabel = (e) => {
      const m = { accepted: '已接单', completed: '已完成', failed: '失败', test: '测试', reply: '自动回复' };
      return m[e] || e;
    };
    const eventBadgeCls = (e) => e === 'failed' ? 'badge-red' : (e === 'completed' ? 'badge-green' : (e === 'test' ? 'badge-yellow' : (e === 'reply' ? 'badge-accent' : 'badge-blue')));
    table.innerHTML = `<table class="table">
      <thead><tr><th>时间</th><th>事件</th><th>内容</th><th>目标</th><th>状态</th></tr></thead>
      <tbody>${rows.map((o) => `
        <tr>
          <td class="mono faint">${fmtTime(o.at, true)}</td>
          <td><span class="badge ${eventBadgeCls(o.event)}">${escapeHtml(eventLabel(o.event))}</span></td>
          <td style="max-width:360px">${safeText(truncate(o.content, 80))}</td>
          <td>${escapeHtml(contactName(o.wxid))}</td>
          <td>${o.sent ? '<span class="badge badge-green">已发送</span>' : '<span class="badge">已写入</span>'}</td>
        </tr>`).join('')}</tbody></table>`;
  }

  box.querySelector('#prNew').addEventListener('click', () => openRuleModal(null, () => { loadRules(); loadOutbox(); }));
  loadRules();
  loadOutbox();
}

function openRuleModal(rule, done) {
  const isEdit = !!rule;
  openModal({
    title: isEdit ? '编辑推送规则' : '新建推送规则',
    wide: true,
    body: `
      <label class="field"><span>规则名称 *</span><input type="text" id="prName" value="${escapeHtml(rule?.name || '')}" placeholder="如：失败任务即时通知"></label>
      <div class="form-row">
        <div class="field"><span>订阅事件（多选）</span>
          <div class="check-group">${EVENT_OPTS.map((o) => `
            <label><input type="checkbox" data-ev="${o.v}" ${rule?.events?.includes(o.v) ? 'checked' : ''}> ${o.label}</label>`).join('')}
          </div></div>
        <div class="field"><span>来源筛选（不选 = 全部来源）</span>
          <div class="check-group">${Object.entries(SOURCE_MAP).map(([k, v]) => `
            <label><input type="checkbox" data-src="${k}" ${rule?.source_filter?.includes(k) ? 'checked' : ''}> ${v.icon}${v.text}</label>`).join('')}
          </div></div>
      </div>
      <label class="field"><span>目标联系人 *</span>
        <select id="prTarget">
          ${contactsCache.map((c) => `<option value="${c.wxid}" ${rule?.target_wxid === c.wxid ? 'selected' : ''}>${escapeHtml(c.name)} ${c.type === 'room' ? '👥' : '👤'}</option>`).join('')}
        </select></label>
    `,
    okText: isEdit ? '保 存' : '新 建',
    onOk: async (modal) => {
      const name = modal.querySelector('#prName').value.trim();
      const target_wxid = modal.querySelector('#prTarget').value;
      const events = Array.from(modal.querySelectorAll('[data-ev]:checked')).map((el) => el.dataset.ev);
      const source_filter = Array.from(modal.querySelectorAll('[data-src]:checked')).map((el) => el.dataset.src);
      if (!name || !target_wxid || !events.length) { toast('请填写规则名称、目标联系人并至少选择一个事件', 'error'); return false; }
      try {
        if (isEdit) await api.patch(`/api/claw/push-rules/${rule.id}`, { name, events, source_filter, target_wxid });
        else await api.post('/api/claw/push-rules', { name, events, source_filter, target_wxid });
        toast('已保存', 'success');
        if (done) done();
      } catch (err) { toast(err.message, 'error'); return false; }
    },
  });
}

/* ==================== 会话消息（左联系人 + 右气泡流 + 底部输入框）==================== */
async function renderMessages(box, ctx) {
  let currentWxid = '';
  let contactsStats = [];

  box.innerHTML = `
    <div class="claw-chat-layout">
      <div class="claw-chat-contacts" id="ccList"><div class="loading-line"><span class="spinner"></span></div></div>
      <div class="claw-chat-main">
        <div class="claw-chat-head" id="ccHead">会话消息</div>
        <div class="claw-chat-body" id="ccBody"><div class="empty"><div class="empty-icon">💬</div><p>选择左侧联系人开始会话</p></div></div>
        <div class="claw-chat-input" id="ccInput" style="display:none">
          <textarea id="ccText" placeholder="输入回复内容，Enter 发送（Shift+Enter 换行）"></textarea>
          <button class="btn btn-primary" id="ccSend">发 送</button>
        </div>
      </div>
    </div>`;

  async function loadContacts() {
    if (!box.isConnected) return;
    const holder = box.querySelector('#ccList');
    if (!holder) return;
    try {
      const [list, stats] = await Promise.all([
        api.get('/api/claw/contacts'),
        api.get('/api/claw/contacts/stats').catch(() => []),
      ]);
      contactsCache = list;
      contactsStats = stats;
      const statsMap = new Map(stats.map((s) => [s.wxid, s]));
      // 按最近消息时间倒序，没消息的排后
      const sorted = [...list].sort((a, b) => (statsMap.get(b.wxid)?.last_at || 0) - (statsMap.get(a.wxid)?.last_at || 0));
      if (!sorted.length) {
        holder.innerHTML = '<div class="empty" style="padding:20px 10px"><p style="font-size:12px">暂无联系人</p></div>';
        return;
      }
      holder.innerHTML = sorted.map((c) => {
        const st = statsMap.get(c.wxid) || { count: 0, last_at: 0, unread: 0 };
        return `
          <div class="chat-contact ${currentWxid === c.wxid ? 'active' : ''}" data-wxid="${c.wxid}">
            <span>${c.type === 'room' ? '👥' : '👤'}</span>
            <span class="cc-name">${escapeHtml(c.name)}</span>
            ${st.unread > 0 ? `<span class="cc-unread">${st.unread}</span>` : ''}
            ${st.last_at ? `<span class="cc-time">${relTime(st.last_at)}</span>` : ''}
          </div>`;
      }).join('');
      holder.querySelectorAll('.chat-contact').forEach((el) => {
        el.addEventListener('click', () => selectContact(el.dataset.wxid));
      });
    } catch (err) {
      holder.innerHTML = `<div class="empty" style="padding:20px 10px"><p style="font-size:12px;color:var(--red)">${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function selectContact(wxid) {
    currentWxid = wxid;
    // 切换高亮
    box.querySelectorAll('.chat-contact').forEach((el) => el.classList.toggle('active', el.dataset.wxid === wxid));
    const c = contactsCache.find((x) => x.wxid === wxid);
    const head = box.querySelector('#ccHead');
    const bodyEl = box.querySelector('#ccBody');
    const inputArea = box.querySelector('#ccInput');
    if (head) head.innerHTML = `${c.type === 'room' ? '👥' : '👤'} ${escapeHtml(c.name)} <span class="faint mono" style="font-size:11px">${escapeHtml(wxid)}</span>`;
    if (inputArea) inputArea.style.display = 'flex';
    if (bodyEl) bodyEl.innerHTML = '<div class="loading-line"><span class="spinner"></span></div>';
    try {
      const msgs = await api.get(`/api/claw/messages?wxid=${encodeURIComponent(wxid)}&limit=200`);
      if (!box.isConnected) return;
      if (!Array.isArray(msgs) || !msgs.length) {
        bodyEl.innerHTML = '<div class="empty"><div class="empty-icon">💬</div><p>暂无消息记录</p></div>';
      } else {
        const grouped = [];
        let lastDate = '';
        for (const m of msgs) {
          const d = new Date(m.at * 1000).toLocaleDateString('zh-CN');
          if (d !== lastDate) { grouped.push({ type: 'date', text: d }); lastDate = d; }
          grouped.push({ type: 'msg', m });
        }
        bodyEl.innerHTML = `<div style="max-width:760px;margin:0 auto">${grouped.map((item) => {
          if (item.type === 'date') return `<div style="text-align:center;margin:16px 0"><span class="badge" style="background:var(--bg-soft);color:var(--text-light)">${escapeHtml(item.text)}</span></div>`;
          const m = item.m;
          return `
            <div class="${m.direction === 'in' ? 'msg-in' : 'msg-out'}">
              <div>${safeText(m.content)}</div>
              <div class="msg-meta">
                ${m.direction === 'in' ? '📥 收' : '📤 发'} · ${fmtTime(m.at, true)}
                ${m.task_id ? ` · 任务 <span class="mono">${escapeHtml(String(m.task_id).slice(0, 18))}</span>` : ''}
                ${m.event === 'reply' ? ' · <span style="color:var(--accent)">自动回复</span>' : ''}
              </div>
            </div>`;
        }).join('')}</div>`;
        // 滚到底
        bodyEl.scrollTop = bodyEl.scrollHeight;
      }
      // 批量标记已读
      try {
        const r = await api.patch('/api/claw/messages/read', { wxid });
        if (r.count > 0) loadContacts(); // 刷新未读徽标
      } catch { /* ignore */ }
    } catch (err) {
      bodyEl.innerHTML = `<div class="empty"><div class="empty-icon">💬</div><p>加载失败：${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function sendReply() {
    const ta = box.querySelector('#ccText');
    const btn = box.querySelector('#ccSend');
    if (!ta || !btn || !currentWxid) return;
    const content = ta.value.trim();
    if (!content) { toast('请输入内容', 'error'); return; }
    btn.disabled = true;
    try {
      await api.post('/api/claw/send', { wxid: currentWxid, content });
      ta.value = '';
      toast('已发送', 'success');
      await selectContact(currentWxid); // 刷新消息流
      await loadContacts(); // 刷新列表
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  }

  box.querySelector('#ccSend').addEventListener('click', sendReply);
  box.querySelector('#ccText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
  });

  await loadContacts();
  // 默认选第一个联系人
  if (contactsCache.length) {
    const first = box.querySelector('.chat-contact');
    if (first) selectContact(first.dataset.wxid);
  }

  // 每 10s 轮询刷新联系人列表（拿新未读），若当前在会话中不强制刷新消息流
  const timer = setInterval(() => {
    if (box.isConnected) loadContacts();
  }, 10_000);
  ctx.onCleanup(() => clearInterval(timer));
}
