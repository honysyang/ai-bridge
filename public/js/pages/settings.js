/* ============================================================
   pages/settings.js — 设置：AI 模型 ｜ 用户管理 ｜ 系统 ｜ 日志
   ============================================================ */
import {
  api, toast, escapeHtml, fmtTime, emptyHTML, openModal, confirmBox, truncate,
} from '../api.js';

export async function render(el, ctx) {
  el.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="models">AI 模型</div>
      <div class="tab" data-tab="users">用户管理</div>
      <div class="tab" data-tab="system">系统</div>
      <div class="tab" data-tab="logs">日志</div>
    </div>
    <div id="tabBody"><div class="loading-line"><span class="spinner"></span> 加载中…</div></div>`;
  const body = el.querySelector('#tabBody');
  const renderTab = (tab) => {
    el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'models') renderModels(body);
    else if (tab === 'users') renderUsers(body, ctx);
    else if (tab === 'system') renderSystem(body);
    else renderLogs(body, ctx);
  };
  el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => renderTab(t.dataset.tab)));
  renderTab('models');
}

/* ==================== AI 模型 ==================== */
async function renderModels(box) {
  box.innerHTML = `
    <div class="card">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">🧠 AI 模型配置
          <span class="sub">平台统一调用的模型清单（存 settings，GET/PATCH /api/settings/ai-models）</span></div>
        <div class="flex">
          <button class="btn" id="mAdd">＋ 添加模型</button>
          <button class="btn btn-primary" id="mSave">💾 保存全部</button>
        </div>
      </div>
      <div class="table-wrap" id="mTable"><div class="loading-line"><span class="spinner"></span> 加载模型配置…</div></div>
    </div>`;

  let models = [];
  let aiRouting = {};
  try {
    const data = await api.get('/api/settings/ai-models');
    models = data?.models || [];
    aiRouting = data?.ai_routing || {};
  } catch (err) {
    box.querySelector('#mTable').innerHTML = emptyHTML('🧠', '模型配置加载失败', err.message);
    return;
  }

  function renderTable() {
    const table = box.querySelector('#mTable');
    if (!models.length) {
      table.innerHTML = emptyHTML('🧠', '尚未配置 AI 模型', '点击「添加模型」配置 base_url / model / api_key');
      return;
    }
    table.innerHTML = `<table class="table">
      <thead><tr><th>名称</th><th>厂商</th><th>base_url</th><th>model</th><th>api_key</th><th></th></tr></thead>
      <tbody>${models.map((m, i) => `
        <tr data-i="${i}">
          <td><input type="text" data-f="name" value="${escapeHtml(m.name || '')}" placeholder="显示名"></td>
          <td><input type="text" data-f="provider" value="${escapeHtml(m.provider || '')}" placeholder="如 openai / deepseek"></td>
          <td style="min-width:220px"><input type="text" data-f="base_url" value="${escapeHtml(m.base_url || '')}" placeholder="https://api.example.com/v1"></td>
          <td><input type="text" data-f="model" value="${escapeHtml(m.model || '')}" placeholder="gpt-4o-mini"></td>
          <td><input type="password" data-f="api_key" value="${escapeHtml(m.api_key || '')}" placeholder="sk-…"></td>
          <td><button class="btn btn-sm btn-danger" data-del="${i}">删除</button></td>
        </tr>`).join('')}</tbody></table>`;
    table.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const tr = inp.closest('tr');
        models[parseInt(tr.dataset.i, 10)][inp.dataset.f] = inp.value;
      });
    });
    table.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        models.splice(parseInt(btn.dataset.del, 10), 1);
        renderTable();
      });
    });
  }

  function renderRouting() {
    const wrap = box.querySelector('#mRouting');
    if (!models.length) { wrap.innerHTML = ''; return; }
    const purposes = [
      { key: 'compress', label: '上下文压缩' },
      { key: 'route', label: '智能路由' },
      { key: 'report', label: '周报洞察' },
      { key: 'qa', label: '知识问答预留' },
      { key: 'default', label: '默认模型' },
    ];
    wrap.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div class="card-title" style="margin:0 0 8px">🎯 用途绑定</div>
        <p class="sub" style="margin:0 0 12px">为不同用途选择上方已配置的模型。未绑定时会回落到默认模型。</p>
        <div class="form-grid">${purposes.map((p) => `
          <label class="field">
            <span>${p.label}</span>
            <select data-rkey="${p.key}">
              <option value="">（未绑定）</option>
              ${models.map((m) => `<option value="${escapeHtml(m.name)}" ${aiRouting[p.key] === m.name ? 'selected' : ''}>${escapeHtml(m.name || m.model)}</option>`).join('')}
            </select>
          </label>`).join('')}
        </div>
      </div>`;
    wrap.querySelectorAll('[data-rkey]').forEach((sel) => {
      sel.addEventListener('change', () => { aiRouting[sel.dataset.rkey] = sel.value; });
    });
  }

  box.querySelector('#mAdd').addEventListener('click', () => {
    models.push({ name: '', provider: '', base_url: '', model: '', api_key: '' });
    renderTable();
    renderRouting();
  });
  box.querySelector('#mSave').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const cleaned = models.filter((m) => m.name?.trim() || m.model?.trim());
      await api.patch('/api/settings/ai-models', { models: cleaned, ai_routing: aiRouting });
      models = cleaned;
      toast('模型配置已保存', 'success');
      renderTable();
      renderRouting();
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  });

  const routingDiv = document.createElement('div');
  routingDiv.id = 'mRouting';
  box.querySelector('.card').appendChild(routingDiv);
  renderTable();
  renderRouting();
}

/* ==================== 用户管理（admin） ==================== */
async function renderUsers(box, ctx) {
  box.innerHTML = `
    <div class="card">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">👤 用户管理 <span class="sub">仅管理员可见/操作</span></div>
        <button class="btn btn-green" id="uNew">＋ 新建用户</button>
      </div>
      <div class="table-wrap" id="uTable"><div class="loading-line"><span class="spinner"></span> 加载用户…</div></div>
    </div>`;

  async function load() {
    const table = box.querySelector('#uTable');
    let users;
    try { users = await api.get('/api/settings/users'); } catch (err) {
      table.innerHTML = emptyHTML('👤', '用户列表加载失败', err.message + '（需要管理员权限）');
      box.querySelector('#uNew').disabled = true;
      return;
    }
    table.innerHTML = `<table class="table">
      <thead><tr><th>用户名</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${users.map((u) => `
        <tr data-id="${u.id}">
          <td>👤 ${escapeHtml(u.username)}${u.username === ctx.user.username ? ' <span class="badge badge-accent">当前登录</span>' : ''}</td>
          <td>${(u.roles || []).map((r) => `<span class="badge ${r === 'admin' ? 'badge-accent' : ''}">${escapeHtml(r)}</span>`).join(' ')}</td>
          <td class="mono faint">${fmtTime(u.created_at)}</td>
          <td><div class="row-actions">
            <button class="btn btn-sm" data-act="pwd">重置密码</button>
            <button class="btn btn-sm" data-act="role">改角色</button>
            <button class="btn btn-sm btn-danger" data-act="del">删除</button>
          </div></td>
        </tr>`).join('')}</tbody></table>`;

    table.querySelectorAll('tr[data-id]').forEach((tr) => {
      const u = users.find((x) => x.id === tr.dataset.id);
      tr.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const act = btn.dataset.act;
          if (act === 'pwd') {
            openModal({
              title: `重置密码 · ${u.username}`,
              body: '<label class="field"><span>新密码</span><input type="password" id="np"></label>',
              okText: '重 置',
              onOk: async (modal) => {
                const password = modal.querySelector('#np').value;
                if (!password || password.length < 6) { toast('密码至少 6 位', 'error'); return false; }
                await api.patch(`/api/settings/users/${u.id}`, { password });
                toast('密码已重置', 'success');
              },
            });
          } else if (act === 'role') {
            openModal({
              title: `修改角色 · ${u.username}`,
              body: `<div class="check-group">
                <label><input type="checkbox" id="rAdmin" ${(u.roles || []).includes('admin') ? 'checked' : ''}> admin（管理员）</label>
                <label><input type="checkbox" id="rUser" ${(u.roles || []).includes('user') ? 'checked' : ''}> user（普通用户）</label>
              </div>`,
              okText: '保 存',
              onOk: async (modal) => {
                const roles = [];
                if (modal.querySelector('#rAdmin').checked) roles.push('admin');
                if (modal.querySelector('#rUser').checked) roles.push('user');
                if (!roles.length) { toast('至少保留一个角色', 'error'); return false; }
                await api.patch(`/api/settings/users/${u.id}`, { roles });
                toast('角色已更新', 'success');
                load();
              },
            });
          } else if (act === 'del') {
            confirmBox(`确定删除用户「${u.username}」吗？`, async () => {
              await api.del(`/api/settings/users/${u.id}`);
              toast('用户已删除', 'success');
              load();
            });
          }
        });
      });
    });
  }

  box.querySelector('#uNew').addEventListener('click', () => {
    openModal({
      title: '新建用户',
      body: `
        <label class="field"><span>用户名 *</span><input type="text" id="nuName"></label>
        <label class="field"><span>密码 *（至少 6 位）</span><input type="password" id="nuPwd"></label>
        <div class="check-group"><label><input type="checkbox" id="nuAdmin"> 设为管理员</label></div>`,
      okText: '创 建',
      onOk: async (modal) => {
        const username = modal.querySelector('#nuName').value.trim();
        const password = modal.querySelector('#nuPwd').value;
        if (!username || !password) { toast('用户名与密码必填', 'error'); return false; }
        if (password.length < 6) { toast('密码至少 6 位', 'error'); return false; }
        const roles = ['user'];
        if (modal.querySelector('#nuAdmin').checked) roles.push('admin');
        await api.post('/api/settings/users', { username, password, roles });
        toast('用户已创建', 'success');
        load();
      },
    });
  });
  load();
}

/* ==================== 系统 ==================== */
async function renderSystem(box) {
  box.innerHTML = '<div class="loading-line"><span class="spinner"></span> 加载系统信息…</div>';
  let info;
  try { info = await api.get('/api/system/info'); } catch (err) {
    box.innerHTML = emptyHTML('🖥️', '系统信息加载失败', err.message);
    return;
  }
  const up = Math.floor(info.uptime || 0);
  const upText = up >= 3600 ? `${Math.floor(up / 3600)} 小时 ${Math.floor((up % 3600) / 60)} 分` : up >= 60 ? `${Math.floor(up / 60)} 分 ${up % 60} 秒` : `${up} 秒`;
  box.innerHTML = `
    <div class="card">
      <div class="card-title">🖥️ 系统信息</div>
      <table class="table"><tbody>
        <tr><td class="muted" style="width:140px">版本</td><td><span class="badge badge-green">v${escapeHtml(info.version || '-')}</span></td></tr>
        <tr><td class="muted">Node.js</td><td class="mono">${escapeHtml(info.node || '-')}</td></tr>
        <tr><td class="muted">已运行</td><td>${upText}</td></tr>
        <tr><td class="muted">任务总数</td><td class="mono">${info.tasks_total ?? '-'}</td></tr>
        <tr><td class="muted">智能体总数</td><td class="mono">${info.agents_total ?? '-'}</td></tr>
        <tr><td class="muted">数据目录</td><td class="mono">${escapeHtml(info.data_dir || '-')}</td></tr>
      </tbody></table>
    </div>
    <div class="card">
      <div class="card-title">🗄️ 数据目录说明</div>
      <p class="section-desc">所有持久化数据位于上方数据目录，采用 append-only JSONL 事件流，重启时全量回放：</p>
      <ul style="padding-left:20px;font-size:13px;line-height:2">
        <li><span class="mono">*.jsonl</span> —— tasks / agents / users / sessions / kb / prompts / workflows / schedules / messages / push_rules / outbox / logs / workflow_runs / contacts 等集合的事件流</li>
        <li><span class="mono">settings.json</span> —— 单对象设置（AI 模型配置、claw 连接状态等）</li>
        <li><span class="mono">secrets.json</span> —— JWT 密钥等敏感信息（请勿外泄）</li>
        <li>备份方式：直接整体复制数据目录即可；删除目录后重启将重新初始化（播种 admin/admin123）。</li>
      </ul>
    </div>`;
}

/* ==================== 日志 ==================== */
async function renderLogs(box, ctx) {
  box.innerHTML = `
    <div class="card">
      <div class="filter-bar">
        <label class="field"><span>级别</span>
          <select id="logLevel">
            <option value="">全部</option><option value="info">info</option>
            <option value="warn">warn</option><option value="error">error</option>
          </select></label>
        <label class="field"><span>来源</span><input type="text" id="logSource" placeholder="如 http / auth"></label>
        <button class="btn btn-primary" id="logSearch">筛 选</button>
        <button class="btn" id="logRefresh">⟳ 刷新</button>
      </div>
      <div class="table-wrap" id="logTable"><div class="loading-line"><span class="spinner"></span> 加载日志…</div></div>
    </div>`;

  const LEVEL_CLS = { info: 'badge-blue', warn: 'badge-yellow', error: 'badge-red' };

  async function load() {
    const table = box.querySelector('#logTable');
    const p = new URLSearchParams({ limit: '200' });
    const lv = box.querySelector('#logLevel').value;
    const src = box.querySelector('#logSource').value.trim();
    if (lv) p.set('level', lv);
    if (src) p.set('source', src);
    let logs;
    try { logs = await api.get(`/api/logs?${p.toString()}`); } catch (err) {
      table.innerHTML = emptyHTML('🧾', '日志加载失败', err.message);
      return;
    }
    if (!Array.isArray(logs) || !logs.length) {
      table.innerHTML = emptyHTML('🧾', '暂无日志', '系统运行中的关键事件会记录在这里');
      return;
    }
    table.innerHTML = `<table class="table">
      <thead><tr><th>时间</th><th>级别</th><th>来源</th><th>内容</th></tr></thead>
      <tbody>${logs.map((l) => `
        <tr>
          <td class="mono faint" style="white-space:nowrap">${fmtTime(l.at || l.created_at, true)}</td>
          <td><span class="badge ${LEVEL_CLS[l.level] || ''}">${escapeHtml(l.level || '-')}</span></td>
          <td class="mono">${escapeHtml(l.source || '-')}</td>
          <td style="word-break:break-all">${escapeHtml(truncate(l.message, 200))}</td>
        </tr>`).join('')}</tbody></table>`;
  }

  box.querySelector('#logSearch').addEventListener('click', load);
  box.querySelector('#logRefresh').addEventListener('click', load);
  box.querySelector('#logSource').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  load();
  const timer = setInterval(() => { if (box.isConnected) load(); }, 15000);
  ctx.onCleanup(() => clearInterval(timer));
}
