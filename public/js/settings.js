// ======== v5.5.3 设置模块 ========
//
// 分栏设置：左侧导航 + 右侧内容 + 统一保存/取消 + 搜索过滤
// 包含 6 个子区段：AI 模型 / 系统行为 / 日志与存储 / 微信桥接 / 安全 / 关于
// 依赖：Core（api/escapeHtml/showNotification/formatBytes）

(function (global) {
  'use strict';

  const Core = global.Core;
  const { api, escapeHtml, showNotification, formatBytes } = Core;

  // 内存缓存（避免重复请求）
  let catalogCache = null;
  let systemSettingsCache = null;
  let idleStatusCache = null;

  // 区段配置
  const SECTIONS = {
    models: { label: 'AI 模型', icon: '🤖', load: loadModels, save: saveModels, reset: resetDefaultModel },
    system: { label: '系统行为', icon: '🛠', load: loadSystem, save: saveSystem, reset: resetSystem },
    logs: { label: '日志与存储', icon: '📜', load: loadLogs, save: saveSystem, reset: resetSystem },
    wechat: { label: '微信桥接', icon: '💬', load: loadWechat, save: saveWechat, reset: null },
    users: { label: '用户管理', icon: '👥', load: loadUsers, save: null, reset: null, adminOnly: true },
    security: { label: '安全', icon: '🔐', load: loadSecurity, save: null, reset: null },
    about: { label: '关于', icon: 'ℹ️', load: loadAbout, save: null, reset: null }
  };

  let currentUser = null;

  let currentSection = 'models';
  let dirtySections = new Set();

  // ======== 公共工具 ========

  function setDirty(dirty) {
    const badge = document.getElementById('settings-dirty-badge');
    if (badge) badge.hidden = !dirty;
    if (dirty) dirtySections.add(currentSection);
    else dirtySections.delete(currentSection);
  }

  function $(id) { return document.getElementById(id); }

  function valueOf(id) {
    const el = $(id);
    if (!el) return null;
    if (el.type === 'checkbox') return el.checked;
    return el.value;
  }

  function setValue(id, val) {
    const el = $(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val === undefined || val === null ? '' : val;
  }

  // ======== 导航 ========

  async function switchSection(name) {
    if (!SECTIONS[name]) name = 'models';
    const cfg = SECTIONS[name];
    // admin 专属区段：非 admin 用户自动跳回 models
    if (cfg.adminOnly && (!currentUser || currentUser.role !== 'admin')) {
      showNotification('⛔ 该功能仅管理员可用', 'warning');
      name = 'models';
    }
    currentSection = name;

    document.querySelectorAll('.settings-nav-item').forEach(b => {
      const active = b.dataset.section === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    document.querySelectorAll('.settings-section').forEach(s => {
      s.hidden = s.id !== `settings-section-${name}`;
    });

    $('settings-active-icon').textContent = SECTIONS[name].icon;
    $('settings-active-label').textContent = SECTIONS[name].label;

    const hasSave = !!SECTIONS[name].save;
    $('btn-settings-save').hidden = !hasSave;
    $('btn-settings-cancel').hidden = !hasSave;

    SECTIONS[name].load();
    setDirty(false);
  }

  function filterSections(keyword) {
    const k = keyword.trim().toLowerCase();
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
      const section = btn.dataset.section;
      const secEl = $(`settings-section-${section}`);
      const kw = (secEl && secEl.dataset.searchKeywords) || '';
      const label = (SECTIONS[section] && SECTIONS[section].label) || '';
      const match = !k || label.toLowerCase().includes(k) || kw.toLowerCase().includes(k);
      btn.style.display = match ? '' : 'none';
    });
  }

  // ======== AI 模型区段 ========

  let editingCustomProviders = [];

  function renderProviderSelect(providers, selectedId, elementId) {
    const sel = $(elementId || 'setting-model-provider');
    if (!sel) return;
    sel.innerHTML = providers.map(p =>
      `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');
  }

  function renderModelSelect(providers, providerId, selectedModel, elementId, hintId) {
    const sel = $(elementId || 'setting-model-name');
    const hint = hintId ? $(hintId) : $('setting-model-name-hint');
    if (!sel) return;
    const p = providers.find(x => x.id === providerId);
    if (!p) {
      sel.innerHTML = '<option value="">-- 请先选服务商 --</option>';
      if (hint) hint.textContent = '';
      return;
    }
    sel.innerHTML = p.models.map(m =>
      `<option value="${escapeHtml(m.id)}" ${m.id === selectedModel ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
    ).join('');
    if (hint) {
      const m = p.models.find(x => x.id === selectedModel) || p.models[0];
      if (m) {
        const ctx = m.context_window ? `${(m.context_window / 1000).toFixed(0)}K 上下文` : '';
        const out = m.max_output ? `${(m.max_output / 1000).toFixed(0)}K 输出` : '';
        const tier = m.tier ? ` · ${m.tier}` : '';
        hint.textContent = [m.description, ctx, out, tier].filter(Boolean).join(' · ');
      } else {
        hint.textContent = '';
      }
    }
  }

  function renderCustomProviderList() {
    const el = $('custom-provider-list');
    if (!el) return;
    if (!editingCustomProviders.length) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🏭</div>
          <div class="empty-text">暂无自定义服务商</div>
          <div class="empty-hint">点击右上角「新建服务商」添加</div>
        </div>`;
      return;
    }
    el.innerHTML = editingCustomProviders.map((p, idx) => `
      <div class="provider-card" data-idx="${idx}">
        <div class="provider-card-head">
          <div class="provider-name">
            <input type="text" class="form-input form-input-inline provider-name-input" placeholder="服务商名称" value="${escapeHtml(p.name)}">
            <code><input type="text" class="form-input form-input-inline provider-id-input" placeholder="ID（小写英文）" value="${escapeHtml(p.id)}"></code>
          </div>
          <div class="provider-actions">
            <button class="btn-secondary btn-xs btn-add-model" title="添加模型">＋ 模型</button>
            <button class="btn-danger btn-xs btn-remove-provider" title="删除">🗑</button>
          </div>
        </div>
        <div class="provider-meta">
          <div class="form-group compact">
            <label>Base URL</label>
            <input type="text" class="form-input provider-base-url" placeholder="https://api.example.com/v1" value="${escapeHtml(p.base_url)}">
          </div>
          <div class="form-group compact">
            <label>API Key</label>
            <input type="password" class="form-input provider-api-key" placeholder="${p.api_key ? '已保存，留空不修改' : '请输入 API Key'}" value="">
          </div>
          <div class="form-group compact">
            <label>默认模型</label>
            <select class="form-input provider-default-model">
              <option value="">-- 选择默认模型 --</option>
              ${p.models.map(m => `<option value="${escapeHtml(m.id)}" ${m.id === p.default_model ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="provider-models">
          ${p.models.map((m, mIdx) => `
            <div class="provider-model-pill model-editing" data-midx="${mIdx}">
              <input type="text" class="form-input form-input-inline model-id" placeholder="模型 ID" value="${escapeHtml(m.id)}">
              <input type="text" class="form-input form-input-inline model-name" placeholder="显示名" value="${escapeHtml(m.name)}">
              <button class="btn-danger btn-xs btn-remove-model" title="删除模型">×</button>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    el.querySelectorAll('.provider-card').forEach(card => {
      const idx = parseInt(card.dataset.idx, 10);
      const p = editingCustomProviders[idx];

      card.querySelector('.provider-name-input')?.addEventListener('change', e => { p.name = e.target.value; setDirty(true); });
      card.querySelector('.provider-id-input')?.addEventListener('change', e => { p.id = e.target.value.trim().toLowerCase(); setDirty(true); });
      card.querySelector('.provider-base-url')?.addEventListener('change', e => { p.base_url = e.target.value; setDirty(true); });
      card.querySelector('.provider-api-key')?.addEventListener('change', e => { if (e.target.value) p.api_key = e.target.value; setDirty(true); });
      card.querySelector('.provider-default-model')?.addEventListener('change', e => { p.default_model = e.target.value; setDirty(true); });

      card.querySelector('.btn-add-model')?.addEventListener('click', () => {
        p.models.push({ id: '', name: '' });
        renderCustomProviderList();
        setDirty(true);
      });
      card.querySelector('.btn-remove-provider')?.addEventListener('click', () => {
        if (!confirm(`删除服务商「${p.name || p.id}」？`)) return;
        editingCustomProviders.splice(idx, 1);
        renderCustomProviderList();
        setDirty(true);
      });

      card.querySelectorAll('.model-editing').forEach(pill => {
        const mIdx = parseInt(pill.dataset.midx, 10);
        const m = p.models[mIdx];
        pill.querySelector('.model-id')?.addEventListener('change', e => { m.id = e.target.value.trim(); setDirty(true); });
        pill.querySelector('.model-name')?.addEventListener('change', e => { m.name = e.target.value; setDirty(true); });
        pill.querySelector('.btn-remove-model')?.addEventListener('click', () => {
          p.models.splice(mIdx, 1);
          if (p.default_model && !p.models.some(x => x.id === p.default_model)) p.default_model = '';
          renderCustomProviderList();
          setDirty(true);
        });
      });
    });
  }

  function readCustomProvidersFromUI() {
    return editingCustomProviders.map(p => ({
      id: p.id || p.name?.toLowerCase().replace(/\s+/g, '_') || `custom_${Date.now()}`,
      name: p.name || p.id,
      base_url: p.base_url || '',
      api_key: p.api_key || '',
      default_model: p.default_model || '',
      models: p.models.filter(m => m.id).map(m => ({ id: m.id, name: m.name || m.id }))
    })).filter(p => p.id && p.name && p.models.length > 0);
  }

  async function loadModels() {
    try {
      const { data } = await api('/api/models');
      catalogCache = data;
      const { providers, config } = data;

      renderProviderSelect(providers, config.default_provider, 'setting-model-provider');
      renderModelSelect(providers, config.default_provider, config.default_model, 'setting-model-name', 'setting-model-name-hint');

      renderProviderSelect(providers, config.kb_provider, 'setting-kb-provider');
      renderModelSelect(providers, config.kb_provider, config.kb_model, 'setting-kb-model', 'setting-kb-model-hint');

      editingCustomProviders = JSON.parse(JSON.stringify(config.custom_providers || []));
      renderCustomProviderList();

      const params = config.model_params || {};
      setValue('setting-model-temperature', params.temperature !== undefined ? params.temperature : 0.7);
      setValue('setting-model-max-tokens', params.max_tokens || 2048);
      setValue('setting-model-top-p', params.top_p !== undefined ? params.top_p : 1);
      setValue('setting-model-freq-penalty', params.frequency_penalty || 0);
    } catch (e) {
      showNotification(`❌ 模型加载失败: ${e.message}`, 'error');
    }
  }

  async function saveModels() {
    const provider = valueOf('setting-model-provider');
    const model = valueOf('setting-model-name');
    if (!provider || !model) {
      showNotification('❌ 请先选择默认服务商和模型', 'error');
      return;
    }
    const kbProvider = valueOf('setting-kb-provider');
    const kbModel = valueOf('setting-kb-model');
    if (kbProvider && !kbModel) {
      showNotification('❌ 请选择知识库模型', 'error');
      return;
    }
    try {
      const customProviders = readCustomProvidersFromUI();
      const enabled = new Set(catalogCache?.config?.enabled_providers || []);
      customProviders.forEach(p => enabled.add(p.id));
      if (kbProvider) enabled.add(kbProvider);
      await api('/api/models/config', {
        method: 'PATCH',
        body: JSON.stringify({
          default_provider: provider,
          default_model: model,
          enabled_providers: Array.from(enabled),
          kb_provider: kbProvider || null,
          kb_model: kbModel || null,
          custom_providers: customProviders,
          model_params: {
            temperature: parseFloat(valueOf('setting-model-temperature')) || 0.7,
            max_tokens: parseInt(valueOf('setting-model-max-tokens'), 10) || 2048,
            top_p: parseFloat(valueOf('setting-model-top-p')) || 1,
            frequency_penalty: parseFloat(valueOf('setting-model-freq-penalty')) || 0
          }
        })
      });
      showNotification('✅ AI 模型配置已保存', 'success');
      setDirty(false);
      loadModels();
    } catch (e) {
      showNotification(`❌ 保存失败: ${e.message}`, 'error');
    }
  }

  async function resetDefaultModel() {
    try {
      await api('/api/models/config/reset', { method: 'POST' });
      showNotification('⟲ 已恢复默认模型', 'success');
      setDirty(false);
      loadModels();
    } catch (e) {
      showNotification(`❌ 重置失败: ${e.message}`, 'error');
    }
  }

  // ======== 系统设置区段 ========

  function fillSystemForm(s) {
    setValue('setting-ui-theme', s.ui.theme);
    setValue('setting-ui-density', s.ui.density);
    setValue('setting-ui-language', s.ui.language);
    setValue('setting-ui-animations', s.ui.animations);
    setValue('setting-task-priority', s.tasks.default_priority);
    setValue('setting-task-retries', s.tasks.max_retries);
    setValue('setting-task-auto-retry', s.tasks.auto_retry_on_failure);
    setValue('setting-task-archive-days', s.tasks.archive_after_days);
    setValue('setting-log-level', s.logs.level);
    setValue('setting-log-retention', s.logs.retention_days);
    setValue('setting-log-console', s.logs.console_output);
    setValue('setting-bridge-heartbeat', s.bridge.heartbeat_interval_sec);
    setValue('setting-bridge-poll', s.bridge.long_poll_timeout_sec);
  }

  function readSystemForm() {
    return {
      ui: {
        theme: valueOf('setting-ui-theme'),
        density: valueOf('setting-ui-density'),
        language: valueOf('setting-ui-language'),
        animations: valueOf('setting-ui-animations')
      },
      tasks: {
        default_priority: valueOf('setting-task-priority'),
        max_retries: parseInt(valueOf('setting-task-retries'), 10) || 0,
        auto_retry_on_failure: valueOf('setting-task-auto-retry'),
        archive_after_days: parseInt(valueOf('setting-task-archive-days'), 10) || 7
      },
      logs: {
        level: valueOf('setting-log-level'),
        retention_days: parseInt(valueOf('setting-log-retention'), 10) || 0,
        console_output: valueOf('setting-log-console')
      },
      bridge: {
        heartbeat_interval_sec: parseInt(valueOf('setting-bridge-heartbeat'), 10) || 5,
        long_poll_timeout_sec: parseInt(valueOf('setting-bridge-poll'), 10) || 30
      }
    };
  }

  async function loadSystem() {
    try {
      const { data } = await api('/api/system/settings');
      systemSettingsCache = data;
      fillSystemForm(data);
    } catch (e) {
      showNotification(`❌ 系统设置加载失败: ${e.message}`, 'error');
    }
  }

  async function saveSystem() {
    try {
      const patch = readSystemForm();
      const { data } = await api('/api/system/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      systemSettingsCache = data;
      showNotification('✅ 系统设置已保存', 'success');
      setDirty(false);
    } catch (e) {
      showNotification(`❌ 保存失败: ${e.message}`, 'error');
    }
  }

  async function resetSystem() {
    try {
      const { data } = await api('/api/system/settings/reset', { method: 'POST' });
      systemSettingsCache = data;
      fillSystemForm(data);
      showNotification('⟲ 系统设置已恢复默认', 'success');
      setDirty(false);
    } catch (e) {
      showNotification(`❌ 重置失败: ${e.message}`, 'error');
    }
  }

  // ======== 日志与存储区段 ========

  async function loadLogs() {
    // 日志字段属于系统设置，复用 loadSystem
    await loadSystem();
    await loadStorageInfo();
  }

  async function loadStorageInfo() {
    const el = $('settings-storage-info');
    if (!el) return;
    try {
      const { data: overview } = await api('/api/overview/stats');
      const { data: info } = await api('/api/system/info');
      const files = (overview.storage && overview.storage.files) || [];
      el.innerHTML = `
        <div class="storage-summary">
          <div class="storage-tile"><div class="tile-label">📂 数据目录</div><div class="tile-value"><code>${escapeHtml(info.data_dir)}</code></div></div>
          <div class="storage-tile"><div class="tile-label">📄 文件数</div><div class="tile-value">${info.data_files}</div></div>
          <div class="storage-tile"><div class="tile-label">💾 总占用</div><div class="tile-value">${formatBytes(info.data_bytes)}</div></div>
        </div>
        <table class="storage-table">
          <thead><tr><th>文件</th><th>大小</th><th>行数</th></tr></thead>
          <tbody>
            ${files.map(f => `<tr><td><code>${escapeHtml(f.name)}</code></td><td>${formatBytes(f.bytes)}</td><td>${f.lines || 0}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">暂无数据</td></tr>'}
          </tbody>
        </table>
      `;
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败: ${escapeHtml(e.message)}</div></div>`;
    }
  }

  async function cleanupLogs() {
    if (!confirm('按当前保留天数删除 logs/*.log 文件，确定？')) return;
    try {
      const { data } = await api('/api/system/cleanup', {
        method: 'POST',
        body: JSON.stringify({})
      });
      showNotification(`✅ 清理完成：删除 ${data.removed} 个，保留 ${data.kept} 个`, 'success');
    } catch (e) {
      showNotification(`❌ 清理失败: ${e.message}`, 'error');
    }
  }

  // ======== 微信桥接区段 ========

  function fillWechatForm(cfg) {
    setValue('setting-claw-enabled', cfg.enabled);
    setValue('setting-claw-auto-reply', cfg.auto_reply);
    setValue('setting-claw-dedup', cfg.message_dedup_ttl_ms || 300000);
    setValue('setting-idle-enabled', cfg.idle_enabled);
    setValue('setting-idle-interval', cfg.idle_check_interval_min || 5);
    setValue('setting-idle-min-quiet', cfg.idle_min_quiet_min || 5);
    setValue('setting-idle-cooldown', cfg.idle_cooldown_min || 30);
    setValue('setting-idle-work-start', (cfg.idle_work_hours || {}).start ?? 9);
    setValue('setting-idle-work-end', (cfg.idle_work_hours || {}).end ?? 18);
    setValue('setting-idle-rest-start', (cfg.idle_rest_hours || {}).start ?? 22);
    setValue('setting-idle-rest-end', (cfg.idle_rest_hours || {}).end ?? 7);
    const types = cfg.idle_message_types || [];
    setValue('setting-idle-msg-daily', types.includes('daily_summary'));
    setValue('setting-idle-msg-task', types.includes('task_summary'));
  }

  function readWechatForm() {
    const types = [];
    if (valueOf('setting-idle-msg-daily')) types.push('daily_summary');
    if (valueOf('setting-idle-msg-task')) types.push('task_summary');
    return {
      enabled: valueOf('setting-claw-enabled') ?? true,
      auto_reply: valueOf('setting-claw-auto-reply') ?? true,
      message_dedup_ttl_ms: parseInt(valueOf('setting-claw-dedup'), 10) || 300000,
      idle_enabled: valueOf('setting-idle-enabled') ?? false,
      idle_check_interval_min: parseInt(valueOf('setting-idle-interval'), 10) || 5,
      idle_min_quiet_min: parseInt(valueOf('setting-idle-min-quiet'), 10) || 5,
      idle_cooldown_min: parseInt(valueOf('setting-idle-cooldown'), 10) || 30,
      idle_work_hours: {
        start: parseInt(valueOf('setting-idle-work-start'), 10) || 9,
        end: parseInt(valueOf('setting-idle-work-end'), 10) || 18
      },
      idle_rest_hours: {
        start: parseInt(valueOf('setting-idle-rest-start'), 10) || 22,
        end: parseInt(valueOf('setting-idle-rest-end'), 10) || 7
      },
      idle_message_types: types
    };
  }

  async function loadWechat() {
    try {
      const { data } = await api('/api/claw/config');
      fillWechatForm(data);
    } catch (e) {
      showNotification(`❌ 微信配置加载失败: ${e.message}`, 'error');
    }
    loadIdleStatus();
  }

  async function saveWechat() {
    try {
      const patch = readWechatForm();
      const { data } = await api('/api/claw/config', {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      fillWechatForm(data);
      showNotification('✅ 微信配置已保存（idle notifier 已自动重排）', 'success');
      setDirty(false);
      loadIdleStatus();
    } catch (e) {
      showNotification(`❌ 保存失败: ${e.message}`, 'error');
    }
  }

  async function triggerIdleTick() {
    try {
      const { data } = await api('/api/claw/idle/tick', { method: 'POST', body: '{}' });
      const { checked, sent, skipped, errors, in_work_window } = data;
      const winStr = in_work_window ? '✅ 在窗口' : '⏸ 不在窗口';
      showNotification(
        `${winStr} · 检查 ${checked} 个 wxid · 发送 ${sent} · 跳过 ${skipped}${errors.length ? ' · 错误 ' + errors.length : ''}`,
        errors.length ? 'warning' : (sent > 0 ? 'success' : 'info')
      );
      loadIdleStatus();
    } catch (e) {
      showNotification(`❌ 触发失败: ${e.message}`, 'error');
    }
  }

  async function loadIdleStatus() {
    const el = $('settings-idle-status');
    const winEl = $('setting-idle-window-status');
    if (!el) return;
    try {
      const { data } = await api('/api/claw/idle/status');
      idleStatusCache = data;
      if (winEl) {
        winEl.textContent = data.in_work_window ? '✅ 当前在工作时间内' : '⏸ 当前在休息/非工作时段';
        winEl.style.color = data.in_work_window ? '#059669' : '#94a3b8';
      }
      const lastTick = data.last_tick_at ? new Date(data.last_tick_at).toLocaleString('zh-CN') : '—';
      const lastSent = data.last_sent_at ? new Date(data.last_sent_at).toLocaleString('zh-CN') : '—';
      const rows = [
        ['已初始化', data.initialized ? '✅' : '❌'],
        ['启用状态', data.enabled ? '✅ 启用' : '❌ 禁用'],
        ['工作窗口', data.in_work_window ? '✅ 在窗口内' : '⏸ 不在窗口'],
        ['活跃微信用户', `${data.active_wxid_count} 个`],
        ['上次检查', lastTick],
        ['上次发送', lastSent],
        ['上次目标', data.last_sent_wxid || '—'],
        ['上次结果', data.last_sent_status || '—'],
        ['冷却中 wxid', data.cooldowns && data.cooldowns.length > 0
          ? data.cooldowns.map(c => `${c.wxid.slice(0, 12)}…(剩 ${Math.max(0, Math.round((c.next_avail_at - Date.now()) / 60000))} 分)`).join(', ')
          : '无']
      ];
      el.innerHTML = rows.map(([k, v]) =>
        `<div class="about-row"><div class="about-key">${escapeHtml(k)}</div><div class="about-val">${escapeHtml(String(v))}</div></div>`
      ).join('');
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败: ${escapeHtml(e.message)}</div></div>`;
    }
  }

  // ======== 用户管理区段 ========

  async function loadUsers() {
    const tbody = document.querySelector('#user-list-table tbody');
    if (!tbody) return;
    try {
      const [{ data: me }, { data: users }] = await Promise.all([
        api('/api/auth/me'),
        api('/api/auth/users')
      ]);
      currentUser = me;
      if (!Array.isArray(users) || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">暂无用户</td></tr>';
        return;
      }
      tbody.innerHTML = users.map(u => {
        const created = u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '—';
        const login = u.last_login_at ? new Date(u.last_login_at).toLocaleString('zh-CN') : '—';
        const roleClass = u.role === 'admin' ? 'role-admin' : (u.role === 'operator' ? 'role-operator' : 'role-viewer');
        return `
          <tr data-id="${escapeHtml(u.id)}">
            <td><code>${escapeHtml(u.username)}</code>${u.id === me?.id ? ' <span class="badge badge-info">我</span>' : ''}</td>
            <td>${escapeHtml(u.display_name || '—')}</td>
            <td><span class="role-badge ${roleClass}">${escapeHtml(u.role)}</span></td>
            <td>${u.disabled ? '<span class="badge badge-warn">已禁用</span>' : '<span class="badge badge-ok">正常</span>'}</td>
            <td class="text-muted">${created}</td>
            <td class="text-muted">${login}</td>
            <td class="text-right">
              <button class="btn-secondary btn-xs btn-edit-user" title="编辑角色/状态">编辑</button>
              <button class="btn-secondary btn-xs btn-reset-password" title="重置密码">重置密码</button>
              <button class="btn-danger btn-xs btn-delete-user" title="删除" ${u.id === me?.id ? 'disabled' : ''}>删除</button>
            </td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('.btn-edit-user').forEach(btn => {
        btn.addEventListener('click', () => editUserRole(btn.closest('tr').dataset.id));
      });
      tbody.querySelectorAll('.btn-reset-password').forEach(btn => {
        btn.addEventListener('click', () => resetUserPassword(btn.closest('tr').dataset.id));
      });
      tbody.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', () => deleteUser(btn.closest('tr').dataset.id));
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted">加载失败: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function addUser() {
    const username = prompt('请输入用户名（小写英文/数字/下划线）：');
    if (!username) return;
    const displayName = prompt('请输入显示名：') || username;
    const role = prompt('角色（admin/operator/viewer，默认 viewer）：') || 'viewer';
    const password = prompt('初始密码（至少 8 位，含字母和数字）：');
    if (!password) return;
    try {
      await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, display_name: displayName, role, password })
      });
      showNotification('✅ 用户已创建', 'success');
      loadUsers();
    } catch (e) {
      showNotification(`❌ 创建失败: ${e.message}`, 'error');
    }
  }

  async function editUserRole(id) {
    const user = (await api('/api/auth/users')).data.find(u => u.id === id);
    if (!user) return;
    const role = prompt(`修改「${user.username}」的角色（admin/operator/viewer）：`, user.role);
    if (!role) return;
    const disabled = confirm(`是否禁用该用户？\n确定=禁用，取消=启用/保持正常`);
    try {
      await api(`/api/auth/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role, disabled })
      });
      showNotification('✅ 用户信息已更新', 'success');
      loadUsers();
    } catch (e) {
      showNotification(`❌ 更新失败: ${e.message}`, 'error');
    }
  }

  async function resetUserPassword(id) {
    const user = (await api('/api/auth/users')).data.find(u => u.id === id);
    if (!user) return;
    const password = prompt(`为「${user.username}」设置新密码（留空则随机生成）：`);
    try {
      const { data } = await api(`/api/auth/users/${id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password })
      });
      prompt(`用户「${data.username}」的密码已重置为：`, data.password);
      showNotification('✅ 密码已重置', 'success');
    } catch (e) {
      showNotification(`❌ 重置失败: ${e.message}`, 'error');
    }
  }

  async function deleteUser(id) {
    const user = (await api('/api/auth/users')).data.find(u => u.id === id);
    if (!user) return;
    if (!confirm(`确定删除用户「${user.username}」？此操作不可撤销。`)) return;
    try {
      await api(`/api/auth/users/${id}`, { method: 'DELETE' });
      showNotification('✅ 用户已删除', 'success');
      loadUsers();
    } catch (e) {
      showNotification(`❌ 删除失败: ${e.message}`, 'error');
    }
  }

  // ======== 安全区段 ========

  async function loadSecurity() {
    const el = $('settings-user-info');
    if (!el) return;
    try {
      const { data } = await api('/api/auth/me');
      if (!data) {
        el.innerHTML = '<div class="empty-state"><div class="empty-text">未登录（本地访问自动放行）</div></div>';
        return;
      }
      const rows = [
        ['用户名', data.username || '—'],
        ['角色', data.role || '—'],
        ['本地访问', data.is_local ? '✅ 自动放行' : '❌ 需认证']
      ];
      el.innerHTML = rows.map(([k, v]) =>
        `<div class="about-row"><div class="about-key">${escapeHtml(k)}</div><div class="about-val">${escapeHtml(String(v))}</div></div>`
      ).join('');
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败: ${escapeHtml(e.message)}</div></div>`;
    }
  }

  async function changePassword() {
    const current = valueOf('setting-current-password');
    const next = valueOf('setting-new-password');
    const confirm = valueOf('setting-confirm-password');
    if (!current || !next) {
      showNotification('❌ 请输入当前密码和新密码', 'error');
      return;
    }
    if (next !== confirm) {
      showNotification('❌ 两次输入的新密码不一致', 'error');
      return;
    }
    try {
      await api('/api/auth/me/password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: current, newPassword: next })
      });
      showNotification('✅ 密码已修改', 'success');
      setValue('setting-current-password', '');
      setValue('setting-new-password', '');
      setValue('setting-confirm-password', '');
    } catch (e) {
      showNotification(`❌ 修改失败: ${e.message}`, 'error');
    }
  }

  // ======== 关于区段 ========

  async function loadAbout() {
    const aboutEl = $('settings-about-info');
    const clawEl = $('settings-claw-info');
    if (aboutEl) aboutEl.innerHTML = '<div class="empty-state"><div class="empty-text">加载中...</div></div>';
    if (clawEl) clawEl.innerHTML = '<div class="empty-state"><div class="empty-text">加载中...</div></div>';
    try {
      const [{ data: info }, { data: overview }] = await Promise.all([
        api('/api/system/info'),
        api('/api/overview/stats')
      ]);
      const started = new Date(info.started_at).toLocaleString('zh-CN');
      const rows = [
        ['Node 版本', info.node_version],
        ['平台 / 架构', `${info.platform} / ${info.arch}`],
        ['PID', info.pid],
        ['启动时间', started],
        ['运行时长', `${info.uptime_sec} 秒 (${Math.floor(info.uptime_sec / 60)} 分钟)`],
        ['内存占用', `${info.memory.rss_mb} MB（堆 ${info.memory.heap_used_mb}/${info.memory.heap_total_mb} MB）`],
        ['数据目录', info.data_dir],
        ['环境', `NODE_ENV=${info.env.NODE_ENV}, LOG_LEVEL=${info.env.LOG_LEVEL}, PORT=${info.env.PORT}`]
      ];
      if (aboutEl) {
        aboutEl.innerHTML = rows.map(([k, v]) =>
          `<div class="about-row"><div class="about-key">${escapeHtml(k)}</div><div class="about-val">${escapeHtml(String(v))}</div></div>`
        ).join('');
      }

      const h = overview.health || {};
      const clawRows = [
        ['总开关', h.claw && h.claw.enabled ? '✅ 启用' : '❌ 禁用'],
        ['连接状态', (h.claw && h.claw.state) || 'idle'],
        ['WxID', (h.claw && h.claw.wxid) || '-'],
        ['数据完整性', `✅ 正常（任务 ${overview.tasks.total} / 会话 ${overview.sessions.total}）`]
      ];
      if (clawEl) {
        clawEl.innerHTML = clawRows.map(([k, v]) =>
          `<div class="about-row"><div class="about-key">${escapeHtml(k)}</div><div class="about-val">${escapeHtml(String(v))}</div></div>`
        ).join('');
      }
    } catch (e) {
      if (aboutEl) aboutEl.innerHTML = `<div class="empty-state"><div class="empty-text">加载失败: ${escapeHtml(e.message)}</div></div>`;
    }
  }

  // ======== 顶部统一操作 ========

  async function handleSave() {
    const cfg = SECTIONS[currentSection];
    if (cfg && cfg.save) await cfg.save();
  }

  async function handleCancel() {
    const cfg = SECTIONS[currentSection];
    if (cfg && cfg.load) {
      await cfg.load();
      setDirty(false);
      showNotification('✕ 已撤销未保存改动', 'info');
    }
  }

  async function handleReset() {
    const cfg = SECTIONS[currentSection];
    if (!cfg || !cfg.reset) return;
    if (!confirm(`确认将「${cfg.label}」恢复为默认值？`)) return;
    await cfg.reset();
  }

  async function handleRefresh() {
    const cfg = SECTIONS[currentSection];
    if (cfg && cfg.load) {
      await cfg.load();
      setDirty(false);
    }
  }

  // ======== 事件绑定 ========

  function bindEvents() {
    // 左侧导航
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchSection(btn.dataset.section));
    });

    // 搜索
    $('settings-search')?.addEventListener('input', (e) => filterSections(e.target.value));

    // 顶部操作按钮
    $('btn-settings-save')?.addEventListener('click', handleSave);
    $('btn-settings-cancel')?.addEventListener('click', handleCancel);
    $('btn-settings-refresh')?.addEventListener('click', handleRefresh);
    // 原「全部恢复默认」改为「恢复当前区段默认」
    $('btn-settings-reset-all')?.addEventListener('click', handleReset);

    // 模型
    $('setting-model-provider')?.addEventListener('change', (e) => {
      if (!catalogCache) return;
      const cfg = catalogCache.config;
      renderModelSelect(catalogCache.providers, e.target.value, cfg.default_model, 'setting-model-name', 'setting-model-name-hint');
      setDirty(true);
    });
    $('setting-kb-provider')?.addEventListener('change', (e) => {
      if (!catalogCache) return;
      const cfg = catalogCache.config;
      renderModelSelect(catalogCache.providers, e.target.value, cfg.kb_model, 'setting-kb-model', 'setting-kb-model-hint');
      setDirty(true);
    });
    ['setting-model-name', 'setting-model-temperature', 'setting-model-max-tokens', 'setting-model-top-p', 'setting-model-freq-penalty',
     'setting-kb-model'].forEach(id => {
      $(id)?.addEventListener('change', () => setDirty(true));
    });
    $('btn-add-provider')?.addEventListener('click', () => {
      editingCustomProviders.push({ id: '', name: '', base_url: '', api_key: '', models: [], default_model: '' });
      renderCustomProviderList();
      setDirty(true);
    });

    // 系统设置字段变更
    ['setting-ui-theme', 'setting-ui-density', 'setting-ui-language', 'setting-ui-animations',
     'setting-task-priority', 'setting-task-retries', 'setting-task-auto-retry', 'setting-task-archive-days',
     'setting-log-level', 'setting-log-retention', 'setting-log-console',
     'setting-bridge-heartbeat', 'setting-bridge-poll'].forEach(id => {
      $(id)?.addEventListener('change', () => setDirty(true));
    });

    // 日志清理
    $('btn-setting-log-cleanup')?.addEventListener('click', cleanupLogs);

    // 微信字段变更
    ['setting-claw-enabled', 'setting-claw-auto-reply', 'setting-claw-dedup',
     'setting-idle-enabled', 'setting-idle-interval', 'setting-idle-min-quiet', 'setting-idle-cooldown',
     'setting-idle-work-start', 'setting-idle-work-end', 'setting-idle-rest-start', 'setting-idle-rest-end',
     'setting-idle-msg-daily', 'setting-idle-msg-task'].forEach(id => {
      $(id)?.addEventListener('change', () => setDirty(true));
    });
    $('btn-setting-idle-tick')?.addEventListener('click', triggerIdleTick);

    // 安全
    $('btn-setting-change-password')?.addEventListener('click', changePassword);

    // 用户管理
    $('btn-add-user')?.addEventListener('click', addUser);
  }

  function initSettings() {
    bindEvents();
    // 先获取当前用户，隐藏 admin 专属导航
    api('/api/auth/me').then(({ data }) => {
      currentUser = data;
      document.querySelectorAll('.settings-nav-item[data-admin-only="true"]').forEach(btn => {
        btn.hidden = !(data && data.role === 'admin');
      });
    }).catch(() => {
      document.querySelectorAll('.settings-nav-item[data-admin-only="true"]').forEach(btn => { btn.hidden = true; });
    });
    // 默认进入 models 区段
    switchSection('models');
  }

  global.Settings = {
    init: initSettings,
    refresh: () => switchSection(currentSection)
  };
})(window);
