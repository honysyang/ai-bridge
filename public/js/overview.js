// ======== v5.2.0 概览模块 ========
//
// 第五个主菜单：统计数据卡片 + 任务趋势 + 来源分布 + 系统健康 + 新用户上手
// 依赖：Core（api/escapeHtml/showNotification）

(function (global) {
  'use strict';

  const Core = global.Core;
  const { api, escapeHtml, showNotification, formatBytes } = Core;
  const SOURCE_LABEL = {
    chat: '💬 聊天',
    manual: '✍️ 手动',
    wechat: '💬 微信',
    workflow: '🔄 工作流',
    scheduled: '⏰ 定时',
    system: '⚙️ 系统'
  };
  const SOURCE_COLOR = {
    chat: '#3b82f6',
    manual: '#8b5cf6',
    wechat: '#10b981',
    workflow: '#f59e0b',
    scheduled: '#ec4899',
    system: '#64748b'
  };

  let refreshTimer = null;

  async function loadOverview() {
    const greeting = document.getElementById('overview-greeting');
    if (greeting) {
      const hour = new Date().getHours();
      const greet = hour < 6 ? '夜深了，注意休息' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
      const tasks = (document.querySelector('.tab-count#tab-count-chat')?.textContent || '').trim();
      greeting.textContent = `${greet}，这里是 ai-bridge 实时数据快照`;
    }
    try {
      const { data } = await api('/api/overview/stats');
      renderStats(data);
      renderTrend(data.trend || []);
      renderSourceDist(data.source_dist || {});
      renderHealth(data.health || {});
      renderStorage(data.storage || {});
      renderRecentTasks(data.recent_tasks || []);
    } catch (e) {
      showNotification(`❌ 概览加载失败: ${e.message}`, 'error');
    }
  }

  function renderStats(d) {
    // 任务总数
    setStat('tasks', d.tasks.total, `${d.tasks.pending} 待处理 · ${d.tasks.processing} 进行中 · ${d.tasks.completed} 已完成`);
    // 成功率
    const rate = d.tasks.success_rate;
    setStat('success_rate', rate == null ? '—' : rate + '%',
      rate == null ? '暂无已完成任务' : (rate >= 90 ? '🎯 表现优秀' : rate >= 70 ? '⚠️ 关注失败' : '❌ 需排查'));
    // 知识库
    setStat('kb', d.kb.items, `${d.kb.categories} 分类 · ${d.kb.links} 关联`);
    // 工作流
    setStat('wf', d.wf.templates, `${d.wf.steps} 步骤`);
    // 会话
    setStat('sessions', d.sessions.total, `${d.sessions.active} 活跃 · ${d.sessions.archived} 归档`);
    // 存储
    setStat('storage', formatBytes(d.storage.total_bytes), `${d.storage.files.length} 个文件`);
  }

  function setStat(key, value, trend) {
    const card = document.querySelector(`.stat-card[data-stat="${key}"]`);
    if (!card) return;
    card.querySelector('[data-value]').textContent = value;
    card.querySelector('[data-trend]').textContent = trend;
  }

  function renderTrend(trend) {
    const el = document.getElementById('overview-trend-chart');
    if (!el) return;
    if (trend.length === 0 || trend.every(b => b.count === 0)) {
      el.innerHTML = '<div class="empty-state"><div class="empty-text">暂无趋势数据</div></div>';
      return;
    }
    const max = Math.max(1, ...trend.map(b => b.count));
    const w = 360, h = 120, pad = 20;
    const bw = (w - pad * 2) / trend.length;
    const bars = trend.map((b, i) => {
      const bh = (b.count / max) * (h - pad * 2);
      const x = pad + i * bw;
      const y = h - pad - bh;
      const successH = b.count > 0 ? (b.success / b.count) * bh : 0;
      return `
        <g>
          <rect x="${x + 2}" y="${y}" width="${bw - 4}" height="${bh}" rx="2" fill="#cbd5e1"/>
          <rect x="${x + 2}" y="${y}" width="${bw - 4}" height="${successH}" rx="2" fill="#10b981"/>
          <text x="${x + bw / 2}" y="${h - 4}" text-anchor="middle" font-size="9" fill="#64748b">${b.date.slice(5)}</text>
          <text x="${x + bw / 2}" y="${y - 3}" text-anchor="middle" font-size="9" fill="#0f172a" font-weight="600">${b.count}</text>
        </g>
      `;
    }).join('');
    el.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
        <text x="${pad}" y="14" font-size="10" fill="#94a3b8">⬛ 总任务  🟩 成功</text>
        ${bars}
      </svg>
    `;
  }

  function renderSourceDist(dist) {
    const el = document.getElementById('overview-source-chart');
    if (!el) return;
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    if (total === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-text">暂无任务</div></div>';
      return;
    }
    const rows = Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .map(([src, count]) => {
        const pct = Math.round(count / total * 100);
        const color = SOURCE_COLOR[src] || '#94a3b8';
        return `
          <div class="source-row">
            <span class="source-label">${SOURCE_LABEL[src] || src}</span>
            <div class="source-bar"><div class="source-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="source-count">${count} (${pct}%)</span>
          </div>
        `;
      }).join('');
    el.innerHTML = rows;
  }

  function renderHealth(h) {
    const el = document.getElementById('overview-health');
    if (!el) return;
    const upMin = Math.floor(h.server_uptime_sec / 60);
    const upStr = upMin < 60 ? `${upMin} 分钟` : `${Math.floor(upMin / 60)} 小时 ${upMin % 60} 分`;
    const clawIcon = h.claw.connected ? '✅' : (h.claw.enabled ? '⏳' : '⏸');
    const clawState = h.claw.connected ? '已登录' : (h.claw.enabled ? h.claw.state : '未启用');
    el.innerHTML = `
      <div class="health-grid">
        <div class="health-item"><span class="health-label">⏱ 服务运行</span><span class="health-value">${upStr}</span></div>
        <div class="health-item"><span class="health-label">🟢 Node.js</span><span class="health-value">${escapeHtml(h.node_version)}</span></div>
        <div class="health-item"><span class="health-label">💾 内存占用</span><span class="health-value">${h.memory_mb} MB</span></div>
        <div class="health-item"><span class="health-label">${clawIcon} 微信 Claw</span><span class="health-value">${escapeHtml(clawState)}</span></div>
        <div class="health-item"><span class="health-label">📂 数据目录</span><span class="health-value">${escapeHtml(h.data_dir)}</span></div>
        <div class="health-item"><span class="health-label">🕐 服务器时间</span><span class="health-value">${new Date(h.server_time).toLocaleTimeString()}</span></div>
      </div>
    `;
  }

  function renderStorage(s) {
    // 已并入 setStat('storage')，留空
  }

  function renderRecentTasks(list) {
    const el = document.getElementById('overview-activity-list');
    const cnt = document.getElementById('overview-activity-count');
    if (cnt) cnt.textContent = `${list.length} 条`;
    if (!el) return;
    if (list.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-text">暂无最近活动</div></div>';
      return;
    }
    el.innerHTML = `<div class="activity-list">${list.map(t => {
      const ts = new Date(t.ts);
      const timeStr = isNaN(ts.getTime()) ? '' :
        (() => {
          const diff = (Date.now() - ts.getTime()) / 1000;
          if (diff < 60) return '刚刚';
          if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
          if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
          return Math.floor(diff / 86400) + ' 天前';
        })();
      const status = (t.status || '').toLowerCase();
      const source = t.source || '';
      const content = (t.content || '(无内容)').replace(/</g, '&lt;');
      return `
        <div class="activity-row" data-task-id="${escapeHtml(t.id)}">
          <span class="activity-dot status-${escapeHtml(status)}"></span>
          <span class="activity-text" title="${escapeHtml(content)}">${escapeHtml(content)}</span>
          <span class="activity-source">${escapeHtml(source)}</span>
          <span class="activity-time">${escapeHtml(timeStr)}</span>
        </div>
      `;
    }).join('')}</div>`;
    // 点击活动行 → 跳转到该任务所在会话
    el.querySelectorAll('.activity-row').forEach(row => {
      row.addEventListener('click', () => {
        const tid = row.dataset.taskId;
        if (tid && global.Tasks && global.Tasks.selectTask) {
          global.Tasks.selectTask(tid);
          // 切到 chat tab
          if (global.Main && global.Main.switchTab) global.Main.switchTab('chat');
        }
      });
    });
  }

  function bindOverviewEvents() {
    const refresh = document.getElementById('btn-overview-refresh');
    if (refresh) refresh.addEventListener('click', () => loadOverview());
    const tour = document.getElementById('btn-overview-tour');
    if (tour) tour.addEventListener('click', () => {
      const t = document.getElementById('overview-tour');
      if (t) t.hidden = !t.hidden;
    });
    const close = document.getElementById('btn-tour-close');
    if (close) close.addEventListener('click', () => {
      const t = document.getElementById('overview-tour');
      if (t) t.hidden = true;
    });

    // 快捷操作卡片
    document.querySelectorAll('.quick-card').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.quick;
        handleQuickAction(action);
      });
    });
  }

  function handleQuickAction(action) {
    switch (action) {
      case 'new-session':
        if (global.Sessions && global.Sessions.createSession) global.Sessions.createSession();
        break;
      case 'add-task':
        if (global.Main && global.Main.switchTab) global.Main.switchTab('chat');
        setTimeout(() => {
          const input = document.getElementById('compose-input');
          if (input) { input.focus(); }
        }, 200);
        break;
      case 'kb-demo':
        if (global.Main && global.Main.switchTab) global.Main.switchTab('kb');
        setTimeout(() => {
          const btn = document.getElementById('btn-kb-seed-demo');
          if (btn) btn.click();
        }, 300);
        break;
      case 'wf-demo':
        if (global.Main && global.Main.switchTab) global.Main.switchTab('workflow');
        setTimeout(() => {
          const btn = document.getElementById('btn-wf-seed-demo');
          if (btn) btn.click();
        }, 300);
        break;
      case 'plan-demo':
        if (global.Main && global.Main.switchTab) global.Main.switchTab('plan');
        setTimeout(() => {
          const btn = document.getElementById('btn-plan-seed-demo');
          if (btn) btn.click();
        }, 300);
        break;
      case 'report':
        if (global.Main && global.Main.switchTab) global.Main.switchTab('plan');
        setTimeout(() => {
          if (typeof window.openWeeklyReportDrawer === 'function') window.openWeeklyReportDrawer();
        }, 300);
        break;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(() => {
      // 仅在当前显示概览面板时刷新（避免无谓请求）
      const panel = document.getElementById('panel-overview');
      if (panel && !panel.hidden) loadOverview();
    }, 30000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function initOverview() {
    bindOverviewEvents();
    startAutoRefresh();
    // 立即加载一次（确保 #tab/overview 刷新也能看到数据）
    loadOverview();
  }

  global.Overview = {
    init: initOverview,
    load: loadOverview,
    startAutoRefresh,
    stopAutoRefresh
  };
})(window);
