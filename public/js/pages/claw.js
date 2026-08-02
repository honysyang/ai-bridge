/* ============================================================
   pages/claw.js — 消息通信：连接 ｜ 联系人 ｜ 推送订阅 ｜ 消息记录
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

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="conn">连接</div>
      <div class="tab" data-tab="contacts">联系人</div>
      <div class="tab" data-tab="push">推送订阅</div>
      <div class="tab" data-tab="msgs">消息记录</div>
    </div>
    <div id="tabBody"><div class="loading-line"><span class="spinner"></span> 加载中…</div></div>`;
  const body = el.querySelector('#tabBody');
  const renderTab = (tab) => {
    el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'conn') renderConn(body, ctx);
    else if (tab === 'contacts') renderContacts(body);
    else if (tab === 'push') renderPush(body);
    else renderMessages(body);
  };
  el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => renderTab(t.dataset.tab)));
  try {
    contactsCache = await api.get('/api/claw/contacts');
    groupsCache = await api.get('/api/claw/contacts/groups');
  } catch { contactsCache = []; groupsCache = []; }
  renderTab('conn');
}

/* ==================== 连接 ==================== */
async function renderConn(box, ctx) {
  let st;
  try { st = await api.get('/api/claw/status'); } catch (e) {
    box.innerHTML = emptyHTML('📡', '状态加载失败', e.message);
    return;
  }
  const isMockMode = !!st.mock;

  box.innerHTML = `
    <div class="claw-notice">
      ${isMockMode
        ? '🧪 当前为内置 <b>mock 适配器</b>，可生成演示二维码和模拟消息流（不会连接真实微信）。'
        : '🔌 iLink Bot 适配器 · 扫码登录个人微信（iPad 协议，凭证存于 <code>&lt;data&gt;/secrets/ilink.env</code>）'}
    </div>

    <div class="flex" style="align-items:flex-start;flex-wrap:wrap;gap:18px">
      <div class="card" style="flex:1;min-width:320px">
        <div class="card-title">📡 连接状态</div>
        <div id="connStatus"></div>
        <div class="row-actions mt16">
          <button class="btn btn-green" id="btnLogin">${isMockMode ? '📷 生成演示二维码' : (st.state === 'qrcode' ? '🔄 刷新二维码' : '📷 扫码登录')}</button>
          <button class="btn btn-danger" id="btnLogout">退出登录</button>
          ${!isMockMode ? '<button class="btn" id="btnRestart">↻ 重启 adapter</button>' : ''}
          ${isMockMode ? '<button class="btn btn-sm" id="btnMockConnect" title="跳过二维码，直接建立 mock 连接">⚡ 跳过扫码直接连接</button>' : ''}
        </div>
        <div class="mt16">
          <button class="btn btn-sm" id="btnDiagnose">🔍 连接诊断</button>
          <div id="diagBox" class="mt8" style="display:none"></div>
        </div>
        ${!isMockMode ? `
        <div class="card" style="box-shadow:none;margin-top:14px;background:var(--bg-soft)">
          <div class="card-title" style="font-size:13px">🔑 iLink 凭证</div>
          <div id="credBox" class="mono faint" style="font-size:12px;line-height:1.7">加载中…</div>
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:12px;color:var(--text-light)">手动写入凭证（高级）</summary>
            <div style="margin-top:8px">
              <label class="field"><span>ILINK_BASE_URL</span><input type="text" id="credBase" placeholder="https://ilinkai.weixin.qq.com"></label>
              <label class="field"><span>ILINK_BOT_TOKEN *</span><input type="text" id="credToken" placeholder="扫码后由平台返回的 token"></label>
              <label class="field"><span>ILINK_BOT_ID *</span><input type="text" id="credBotId" placeholder="如：bot_xxxxx"></label>
              <label class="field"><span>ILINK_USER_ID *</span><input type="text" id="credUserId" placeholder="如：oWxxxxxx"></label>
              <button class="btn btn-sm" id="btnSaveCred">💾 保存并启动 adapter</button>
            </div>
          </details>
        </div>` : ''}
      </div>

      <div class="card" style="flex:1;min-width:280px">
        <div class="card-title">📱 ${isMockMode ? '演示二维码' : '微信扫码'}</div>
        <div id="qrcodeBox" style="text-align:center;padding:12px;background:var(--bg-soft);border-radius:8px;min-height:260px">
          <div class="faint" style="font-size:12px;padding:40px 0">${isMockMode ? '点击「生成演示二维码」后会显示二维码' : '点击「扫码登录」后会显示二维码'}</div>
        </div>
        <p class="faint mt8" style="font-size:11px">
          ${isMockMode
            ? '🧪 演示二维码：用手机相机/任意扫码 app 扫一下即可触发模拟登录确认。'
            : '二维码 3 分钟内有效。微信扫码后会自动连接。'}
        </p>
      </div>

      <div class="card claw-mock-form" style="flex:1.4;min-width:340px">
        <h4>📲 ${isMockMode ? '模拟收到微信消息' : '模拟消息（仅 mock 模式可用）'}</h4>
        <p class="section-desc">
          ${isMockMode
            ? '选择联系人并填写内容，提交后将生成一条「微信」来源任务，由智能体处理并回复。'
            : '真实 iLink 模式下，<b>无需手动注入消息</b>。登录后真实微信消息会自动经 <code>/api/claw</code> 入队并生成任务。'}
        </p>
        ${isMockMode ? `
        <label class="field"><span>发送人（联系人 / 群）</span>
          <select id="mockWxid">
            ${contactsCache.map((c) => `<option value="${c.wxid}">${escapeHtml(c.name)} ${c.type === 'room' ? '👥' : '👤'}</option>`).join('')}
          </select></label>
        <label class="field"><span>消息内容</span>
          <textarea id="mockContent" placeholder="如：帮我查一下昨天的任务成功率"></textarea></label>
        <button class="btn btn-primary btn-block" id="mockSend">📩 模拟收到消息 → 创建任务</button>
        <div id="mockResult" class="mt8"></div>
        ` : '<p class="faint" style="font-size:12px;text-align:center;padding:20px">💡 此功能仅在 mock 模式（ILINK_MOCK=1）下可用</p>'}
      </div>
    </div>`;

  async function loadQrImage() {
    const qrBox = box.querySelector('#qrcodeBox');
    if (!qrBox) return;
    qrBox.innerHTML = '<div class="faint" style="font-size:12px;padding:40px 0"><span class="spinner"></span> 加载二维码…</div>';
    try {
      const url = await api.blobUrl('/api/claw/qrcode.png?t=' + Date.now(), 'image/png');
      qrBox.innerHTML = `<img src="${url}" style="width:240px;height:240px;display:block;margin:0 auto;border-radius:4px">`;
    } catch (e) {
      qrBox.innerHTML = `<div class="faint" style="font-size:12px;padding:40px 0">二维码加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  async function loadStatus() {
    const holder = box.querySelector('#connStatus');
    const qrBox = box.querySelector('#qrcodeBox');
    if (!holder || !qrBox) return;
    try {
      st = await api.get('/api/claw/status');
      if (!box.isConnected || !holder || !qrBox) return;
      if (st.mock) {
        holder.innerHTML = `
          <div class="flex mb8">
            ${st.connected
              ? '<span class="badge badge-green" style="font-size:14px;padding:4px 14px"><span class="dot dot-green"></span>已连接（mock）</span>'
              : '<span class="badge" style="font-size:14px;padding:4px 14px"><span class="dot dot-gray"></span>未连接</span>'}
            <span class="badge badge-yellow">mock 适配器</span>
          </div>
          ${st.connected ? `<p class="muted">登录账号：<span class="mono">${escapeHtml(st.account || '-')}</span></p>` : '<p class="faint">点击「生成演示二维码」或「跳过扫码直接连接」</p>'}`;
        if (st.connected) {
          qrBox.innerHTML = `<div style="padding:60px 0;text-align:center"><div style="font-size:48px">✅</div><p class="muted mt8">已连接（mock）· 模拟消息会自动入队</p></div>`;
        } else if (qrShown) {
          loadQrImage();
        } else {
          qrBox.innerHTML = '<div class="faint" style="font-size:12px;padding:40px 0">点击「生成演示二维码」后会显示二维码</div>';
        }
      } else {
        const stateMap = {
          disconnected: ['未连接', 'dot-gray'],
          qrcode: ['等待扫码', 'dot-yellow'],
          connected: ['已连接', 'dot-green'],
          reconnecting: ['重连中…', 'dot-blue'],
        };
        const [label, dot] = stateMap[st.state] || [st.state, 'dot-gray'];
        holder.innerHTML = `
          <div class="flex mb8">
            <span class="badge" style="font-size:14px;padding:4px 14px"><span class="dot ${dot}"></span>${label}</span>
            <span class="badge badge-blue">iLink Bot</span>
          </div>
          ${st.account ? `<p class="muted">登录账号：<span class="mono">${escapeHtml(st.account)}</span></p>` : ''}
          ${st.error ? `<p class="faint" style="color:var(--red)">错误：${escapeHtml(st.error)}</p>` : ''}
          ${st.state === 'disconnected' && st.needsQrcode ? '<p class="faint">点击「扫码登录」开始</p>' : ''}
        `;
        if (st.state === 'qrcode') {
          loadQrImage();
        } else if (st.state === 'connected') {
          qrBox.innerHTML = `<div style="padding:60px 0;text-align:center"><div style="font-size:48px">✅</div><p class="muted mt8">已连接 · 真实消息自动入队</p></div>`;
        } else {
          qrBox.innerHTML = '<div class="faint" style="font-size:12px;padding:40px 0">点击「扫码登录」后会显示二维码</div>';
        }
      }
    } catch (err) {
      if (!box.isConnected || !holder) return;
      holder.innerHTML = emptyHTML('📡', '状态加载失败', err.message);
    }
  }

  async function loadCred() {
    if (isMockMode) return;
    const cbox = box.querySelector('#credBox');
    if (!cbox) return;
    try {
      const c = await api.get('/api/claw/credentials');
      cbox.innerHTML = `
        ILINK_BASE_URL：<b>${escapeHtml(c.ILINK_BASE_URL || '（默认）')}</b><br>
        ILINK_BOT_ID：<b>${escapeHtml(c.ILINK_BOT_ID || '—')}</b><br>
        ILINK_USER_ID：<b>${escapeHtml(c.ILINK_USER_ID || '—')}</b><br>
        ILINK_BOT_TOKEN：${c.has_token ? '<span class="badge badge-green">已设置</span>' : '<span class="badge badge-red">未设置</span>'}<br>
        ${c.ILINK_APP_ID ? `ILINK_APP_ID：<b>${escapeHtml(c.ILINK_APP_ID)}</b><br>` : ''}
      `;
    } catch (e) {
      cbox.innerHTML = `<span class="faint">${escapeHtml(e.message)}</span>`;
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

  let qrShown = false;
  await loadStatus();
  await loadCred();
  if (st?.state === 'qrcode' || (st?.mock && st?.needsQrcode)) {
    qrShown = true;
    loadQrImage();
  }

  const statusTimer = setInterval(() => {
    if (!box.isConnected) return;
    if (isMockMode) {
      if (qrShown) loadStatus();
    } else if (st?.state === 'qrcode') {
      loadStatus();
    }
  }, 2000);
  ctx.onCleanup(() => clearInterval(statusTimer));

  box.querySelector('#btnDiagnose').addEventListener('click', runDiagnose);
  box.querySelector('#btnLogin').addEventListener('click', async () => {
    if (isMockMode) {
      try {
        const r = await api.post('/api/claw/login/start');
        if (r.connected) {
          toast('已建立 mock 连接', 'success');
          qrShown = false;
        } else {
          toast('演示二维码已生成，请用扫码 app 扫一下', 'success');
          qrShown = true;
        }
        setTimeout(loadStatus, 300);
      } catch (err) { toast(err.message, 'error'); }
    } else {
      try {
        await api.post('/api/claw/login/start');
        toast('已触发扫码流程', 'success');
        setTimeout(loadStatus, 500);
      } catch (err) { toast(err.message, 'error'); }
    }
  });
  box.querySelector('#btnLogout').addEventListener('click', async () => {
    try {
      if (isMockMode) await api.post('/api/claw/mock/disconnect');
      else await api.post('/api/claw/logout');
      qrShown = false;
      toast('已退出', 'success');
      loadStatus(); loadCred();
    } catch (err) { toast(err.message, 'error'); }
  });
  box.querySelector('#btnRestart')?.addEventListener('click', async () => {
    try { await api.post('/api/claw/restart'); toast('已重启', 'success'); setTimeout(loadStatus, 1000); }
    catch (err) { toast(err.message, 'error'); }
  });
  box.querySelector('#btnMockConnect')?.addEventListener('click', async () => {
    if (!isMockMode) return;
    try {
      const r = await api.post('/api/claw/mock/connect');
      qrShown = false;
      toast('已建立 mock 连接：' + (r.account || ''), 'success');
      loadStatus();
    } catch (err) { toast(err.message, 'error'); }
  });
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

  if (isMockMode) {
    box.querySelector('#mockSend')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const wxid = box.querySelector('#mockWxid').value;
      const content = box.querySelector('#mockContent').value.trim();
      if (!content) { toast('请填写消息内容', 'error'); return; }
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 创建任务中…';
      try {
        const task = await api.post('/api/claw/mock/incoming', { wxid, content });
        box.querySelector('#mockResult').innerHTML = `
          <div class="card" style="box-shadow:none;margin:0;background:var(--green-soft);border-color:#dde6cc">
            ✅ 已生成任务 <span class="mono">${escapeHtml(task.id)}</span> ${statusBadge(task.status)}
            <div class="mt8"><a href="#/tasks">→ 前往任务中心跟踪执行</a></div>
          </div>`;
        box.querySelector('#mockContent').value = '';
        toast('模拟消息已接收并生成任务', 'success');
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
            <button class="btn btn-green" id="cAdd">＋ 新增</button>
            <button class="btn" id="cSeed">🌱 重新播种</button>
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
      holder.innerHTML = emptyHTML('👥', '暂无联系人', '点击「新增」或「重新播种」添加');
      return;
    }
    holder.innerHTML = `<table class="table">
      <thead><tr><th>名称</th><th>wxid</th><th>类型</th><th>分组</th><th>备注</th><th>操作</th></tr></thead>
      <tbody>${contactsCache.map((c) => `
        <tr data-id="${c.id}">
          <td>${c.type === 'room' ? '👥' : '👤'} ${escapeHtml(c.name)}</td>
          <td class="mono faint">${escapeHtml(c.wxid)}</td>
          <td>${c.type === 'room' ? '群聊' : '好友'}</td>
          <td>${escapeHtml(c.group || '未分组')}</td>
          <td class="faint">${escapeHtml(c.remark || '')}</td>
          <td><div class="row-actions">
            <button class="btn btn-sm btn-primary" data-send="${c.wxid}">✉️ 发消息</button>
            <button class="btn btn-sm" data-edit="${c.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-del="${c.id}">删除</button>
          </div></td>
        </tr>`).join('')}</tbody></table>`;
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
  box.querySelector('#cSeed').addEventListener('click', async () => {
    try { await api.post('/api/claw/contacts/seed'); toast('已重新播种', 'success'); load(); }
    catch (err) { toast(err.message, 'error'); }
  });

  load();
}

function openContactModal(contact, done) {
  const isEdit = !!contact;
  openModal({
    title: isEdit ? '编辑联系人' : '新增联系人',
    body: `
      <label class="field"><span>wxid *</span><input type="text" id="cWxid" value="${isEdit ? escapeHtml(contact.wxid) : ''}" placeholder="如：wxid_xxx" ${isEdit ? 'disabled' : ''}></label>
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
          await api.put(`/api/claw/contacts/${contact.id}`, { name, type, group, remark });
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
      <div class="card-title">📤 推送记录（outbox）</div>
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
      table.innerHTML = emptyHTML('📤', '暂无推送记录', '配置规则并触发任务状态变化后，这里会出现推送流水');
      return;
    }
    table.innerHTML = `<table class="table">
      <thead><tr><th>时间</th><th>事件</th><th>内容</th><th>目标</th><th>状态</th></tr></thead>
      <tbody>${rows.map((o) => `
        <tr>
          <td class="mono faint">${fmtTime(o.at, true)}</td>
          <td><span class="badge ${o.event === 'failed' ? 'badge-red' : o.event === 'completed' ? 'badge-green' : o.event === 'test' ? 'badge-yellow' : 'badge-blue'}">${escapeHtml(EVENT_OPTS.find((e) => e.v === o.event)?.label || o.event)}</span></td>
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

/* ==================== 消息记录 ==================== */
async function renderMessages(box) {
  let filterWxid = '';
  let filterQ = '';

  box.innerHTML = `
    <div class="card" style="padding:14px 16px">
      <div class="flex-between" style="gap:12px;flex-wrap:wrap">
        <div class="flex" style="gap:8px;flex-wrap:wrap">
          <select id="msgWxid" class="input" style="min-width:220px">
            <option value="">所有联系人</option>
            ${contactsCache.map((c) => `<option value="${c.wxid}">${escapeHtml(c.name)} ${c.type === 'room' ? '👥' : '👤'}</option>`).join('')}
          </select>
          <input type="text" id="msgSearch" class="input" placeholder="搜索消息内容" style="min-width:200px">
          <button class="btn" id="msgFilter">🔍 筛选</button>
          <button class="btn btn-ghost" id="msgReset">重置</button>
        </div>
        <div class="flex" style="gap:8px">
          <button class="btn btn-green" id="msgSend">✉️ 主动发消息</button>
          <button class="btn" id="msgRefresh">⟳ 刷新</button>
        </div>
      </div>
    </div>
    <div class="card" style="flex:1;display:flex;flex-direction:column;min-height:420px">
      <div id="msgBody" style="flex:1;overflow-y:auto;max-height:650px;padding-right:8px">
        <div class="loading-line"><span class="spinner"></span> 加载消息…</div>
      </div>
    </div>`;

  async function load() {
    if (!box.isConnected) return;
    const holder = box.querySelector('#msgBody');
    if (!holder) return;
    const p = new URLSearchParams({ limit: '100' });
    if (filterWxid) p.set('wxid', filterWxid);
    if (filterQ) p.set('q', filterQ);
    let msgs;
    try { msgs = await api.get(`/api/claw/messages?${p.toString()}`); } catch (err) {
      if (!box.isConnected || !holder) return;
      holder.innerHTML = emptyHTML('💬', '消息加载失败', err.message);
      return;
    }
    if (!box.isConnected || !holder) return;
    if (!Array.isArray(msgs) || !msgs.length) {
      holder.innerHTML = emptyHTML('💬', '暂无消息记录', filterWxid ? '该联系人暂无消息' : '到「连接」页签模拟收到一条微信消息试试');
      return;
    }
    const grouped = [];
    let lastDate = '';
    for (const m of msgs) {
      const d = new Date(m.at * 1000).toLocaleDateString('zh-CN');
      if (d !== lastDate) { grouped.push({ type: 'date', text: d }); lastDate = d; }
      grouped.push({ type: 'msg', m });
    }
    holder.innerHTML = `<div style="max-width:760px">${grouped.map((item) => {
      if (item.type === 'date') return `<div style="text-align:center;margin:16px 0"><span class="badge" style="background:var(--bg-soft);color:var(--text-light)">${escapeHtml(item.text)}</span></div>`;
      const m = item.m;
      return `
        <div class="${m.direction === 'in' ? 'msg-in' : 'msg-out'}">
          <div>${safeText(m.content)}</div>
          <div class="msg-meta">
            ${m.direction === 'in' ? '📥 收' : '📤 发'} · ${escapeHtml(contactName(m.wxid))} · ${fmtTime(m.at, true)}
            ${m.task_id ? ` · 任务 <span class="mono">${escapeHtml(String(m.task_id).slice(0, 18))}</span>` : ''}
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  function doFilter() {
    filterWxid = box.querySelector('#msgWxid').value;
    filterQ = box.querySelector('#msgSearch').value.trim();
    load();
  }

  box.querySelector('#msgFilter').addEventListener('click', doFilter);
  box.querySelector('#msgSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFilter(); });
  box.querySelector('#msgWxid').addEventListener('change', doFilter);
  box.querySelector('#msgReset').addEventListener('click', () => {
    filterWxid = ''; filterQ = '';
    box.querySelector('#msgWxid').value = '';
    box.querySelector('#msgSearch').value = '';
    load();
  });
  box.querySelector('#msgRefresh').addEventListener('click', load);
  box.querySelector('#msgSend').addEventListener('click', () => {
    const wxid = box.querySelector('#msgWxid').value;
    openSendModal(wxid || contactsCache[0]?.wxid || '', () => load());
  });

  load();
}
