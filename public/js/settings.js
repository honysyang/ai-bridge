// ======== v5.3.0 设置模块 ========
//
// 包含 4 个子区段：AI 模型 / 系统行为 / 日志与存储 / 关于
// 依赖：Core（api/escapeHtml/showNotification/formatBytes）

(function (global) {
  'use strict';

  const Core = global.Core;
  const { api, escapeHtml, showNotification, formatBytes } = Core;

  // 内存缓存（避免重复请求）
  let catalogCache = null;
  let systemSettingsCache = null;

  // ======== AI 模型区段 ========

  function renderProviderSelect(providers, selectedId) {
    const sel = document.getElementById('setting-model-provider');
    if (!sel) return;
    sel.innerHTML = providers.map(p =>
      `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');
  }

  function renderModelSelect(providers, providerId, selectedModel) {
    const sel = document.getElementById('setting-model-name');
    const hint = document.getElementById('setting-model-name-hint');
    if (!sel) return;
    const p = providers.find(x => x.id === providerId);
    if (!p) {
      sel.innerHTML = '<option value="">-- 请先选 Provider --</option>';
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

  function renderProviderList(providers, secrets) {
    const el = document.getElementById('provider-list');
    if (!el) return;
    el.innerHTML = providers.map(p => {
      const s = secrets[p.id] || {};
      const statusBadge = s.api_key_configured
        ? '<span class="badge badge-ok">🔑 已配置</span>'
        : '<span class="badge badge-warn">⚠️ 未配置</span>';
      return `
        <div class="provider-card">
          <div class="provider-card-head">
            <div>
              <div class="provider-name">${escapeHtml(p.name)} <code>${escapeHtml(p.id)}</code></div>
              <div class="provider-desc">${escapeHtml(p.description || '')}</div>
            </div>
            <div class="provider-status">${statusBadge}</div>
          </div>
          <div class="provider-meta">
            <div><span class="meta-label">Base URL</span> <code>${escapeHtml(s.base_url || p.base_url)}</code></div>
            <div><span class="meta-label">API Key</span> <code>${escapeHtml(s.api_key_masked || '(未配置)')}</code></div>
            ${s.model ? `<div><span class="meta-label">环境模型</span> <code>${escapeHtml(s.model)}</code></div>` : ''}
          </div>
          <div class="provider-models">
            ${p.models.map(m => `
              <div class="provider-model-pill" title="${escapeHtml(m.description || '')}">
                <span class="pill-name">${escapeHtml(m.name)}</span>
                <code>${escapeHtml(m.id)}</code>
                ${m.tier ? `<span class="pill-tier">${escapeHtml(m.tier)}</span>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  async function loadModels() {
    try {
      const { data } = await api('/api/models');
      catalogCache = data;
      const { providers, config, secrets } = data;
      renderProviderSelect(providers, config.default_provider);
      renderModelSelect(providers, config.default_provider, config.default_model);
      renderProviderList(providers, secrets);
    } catch (e) {
      showNotification(`❌ 模型加载失败: ${e.message}`, 'error');
    }
  }

  async function saveDefaultModel() {
    const provider = document.getElementById('setting-model-provider').value;
    const model = document.getElementById('setting-model-name').value;
    if (!provider || !model) {
      showNotification('❌ 请先选择 Provider 和模型', 'error');
      return;
    }
    try {
      await api('/api/models/config', {
        method: 'PATCH',
        body: JSON.stringify({ default_provider: provider, default_model: model })
      });
      showNotification('✅ 默认模型已保存', 'success');
      loadModels();
    } catch (e) {
      showNotification(`❌ 保存失败: ${e.message}`, 'error');
    }
  }

  async function resetDefaultModel() {
    try {
      await api('/api/models/config/reset', { method: 'POST' });
      showNotification('⟲ 已恢复默认模型', 'success');
      loadModels();
    } catch (e) {
      showNotification(`❌ 重置失败: ${e.message}`, 'error');
    }
  }

  // ======== 系统设置区段 ========

  function fillSystemForm(s) {
    const $ = (id) => document.getElementById(id);
    if ($('setting-ui-theme')) $('setting-ui-theme').value = s.ui.theme;
    if ($('setting-ui-density')) $('setting-ui-density').value = s.ui.density;
    if ($('setting-ui-language')) $('setting-ui-language').value = s.ui.language;
    if ($('setting-ui-animations')) $('setting-ui-animations').checked = !!s.ui.animations;
    if ($('setting-task-priority')) $('setting-task-priority').value = s.tasks.default_priority;
    if ($('setting-task-retries')) $('setting-task-retries').value = s.tasks.max_retries;
    if ($('setting-task-auto-retry')) $('setting-task-auto-retry').checked = !!s.tasks.auto_retry_on_failure;
    if ($('setting-task-archive-days')) $('setting-task-archive-days').value = s.tasks.archive_after_days;
    if ($('setting-log-level')) $('setting-log-level').value = s.logs.level;
    if ($('setting-log-retention')) $('setting-log-retention').value = s.logs.retention_days;
    if ($('setting-log-console')) $('setting-log-console').checked = !!s.logs.console_output;
    if ($('setting-bridge-heartbeat')) $('setting-bridge-heartbeat').value = s.bridge.heartbeat_interval_sec;
    if ($('setting-bridge-poll')) $('setting-bridge-poll').value = s.bridge.long_poll_timeout_sec;
  }

  function readSystemForm() {
    return {
      ui: {
        theme: document.getElementById('setting-ui-theme').value,
        density: document.getElementById('setting-ui-density').value,
        language: document.getElementById('setting-ui-language').value,
        animations: document.getElementById('setting-ui-animations').checked
      },
      tasks: {
        default_priority: document.getElementById('setting-task-priority').value,
        max_retries: parseInt(document.getElementById('setting-task-retries').value, 10) || 0,
        auto_retry_on_failure: document.getElementById('setting-task-auto-retry').checked,
        archive_after_days: parseInt(document.getElementById('setting-task-archive-days').value, 10) || 7
      },
      logs: {
        level: document.getElementById('setting-log-level').value,
        retention_days: parseInt(document.getElementById('setting-log-retention').value, 10) || 0,
        console_output: document.getElementById('setting-log-console').checked
      },
      bridge: {
        heartbeat_interval_sec: parseInt(document.getElementById('setting-bridge-heartbeat').value, 10) || 5,
        long_poll_timeout_sec: parseInt(document.getElementById('setting-bridge-poll').value, 10) || 30
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
    } catch (e) {
      showNotification(`❌ 重置失败: ${e.message}`, 'error');
    }
  }

  // ======== 存储信息（来自 overview 的 data + 自身 system/info）=======
  async function loadStorageInfo() {
    const el = document.getElementById('settings-storage-info');
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

  // ======== 关于区段 ========
  async function loadAbout() {
    const aboutEl = document.getElementById('settings-about-info');
    const clawEl = document.getElementById('settings-claw-info');
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

  // ======== 子导航 ========
  function switchSection(name) {
    document.querySelectorAll('.subnav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.section === name);
    });
    document.querySelectorAll('.settings-section').forEach(s => {
      s.hidden = s.id !== `settings-section-${name}`;
    });
    // 触发各区段懒加载
    if (name === 'models') loadModels();
    if (name === 'system') loadSystem();
    if (name === 'logs') { loadSystem(); loadStorageInfo(); }
    if (name === 'about') loadAbout();
  }

  // ======== 事件绑定 ========
  function bindEvents() {
    // 顶部按钮
    document.getElementById('btn-settings-refresh')?.addEventListener('click', () => {
      switchSection(document.querySelector('.subnav-btn.active')?.dataset.section || 'models');
    });
    document.getElementById('btn-settings-reset-all')?.addEventListener('click', async () => {
      if (!confirm('确认恢复「系统行为」和「日志与存储」为默认值？（模型默认不受影响，可单独点「恢复默认」）')) return;
      await resetSystem();
    });

    // 子导航
    document.querySelectorAll('.subnav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchSection(btn.dataset.section));
    });

    // 模型
    document.getElementById('setting-model-provider')?.addEventListener('change', (e) => {
      if (!catalogCache) return;
      const cfg = catalogCache.config;
      renderModelSelect(catalogCache.providers, e.target.value, cfg.default_model);
    });
    document.getElementById('btn-setting-model-save')?.addEventListener('click', saveDefaultModel);
    document.getElementById('btn-setting-model-reset')?.addEventListener('click', resetDefaultModel);

    // 系统
    document.getElementById('btn-setting-system-save')?.addEventListener('click', saveSystem);
    document.getElementById('btn-setting-system-reset')?.addEventListener('click', resetSystem);
    // 日志保存和系统保存是同一份数据，复用 saveSystem
    document.getElementById('btn-setting-log-save')?.addEventListener('click', saveSystem);
    document.getElementById('btn-setting-log-cleanup')?.addEventListener('click', cleanupLogs);
  }

  function initSettings() {
    bindEvents();
    // 默认进入 models 区段
    switchSection('models');
  }

  global.Settings = {
    init: initSettings,
    refresh: () => switchSection(document.querySelector('.subnav-btn.active')?.dataset.section || 'models')
  };
})(window);
