// ======== v5.5.7 概览模块（自动刷新 + 弹框上手） ========
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
    chat: '#4f46e5',
    manual: '#7c3aed',
    wechat: '#059669',
    workflow: '#d97706',
    scheduled: '#db2777',
    system: '#64748b'
  };

  const TOUR_STEPS = [
    {
      icon: '💬',
      title: '创建第一个会话',
      desc: '在「聊天」面板左侧会话列表点击 ＋ 新建会话，发送消息或任务。所有任务会自动入队，由智能体处理。',
      tip: '支持文本、任务、代码片段等多种消息类型'
    },
    {
      icon: '📖',
      title: '加载知识库演示数据',
      desc: '进入「知识库」面板，点击「加载演示」按钮，一键写入 6 个分类、20+ 条目，并自动生成关联，开启图谱视图查看。',
      tip: '知识库条目可用于 RAG 检索和任务上下文增强'
    },
    {
      icon: '⚙️',
      title: '执行工作流批量任务',
      desc: '在「工作流」面板选择模板（如「每日天气推送」），点击「执行」即可按依赖顺序自动创建任务，无需手动添加每步。',
      tip: '支持自定义工作流和步骤参数'
    },
    {
      icon: '📅',
      title: '制定计划与生成周报',
      desc: '在「计划」面板添加周/日计划，支持到期微信提醒。周报抽屉一键聚合本周计划、任务、知识库，复制粘贴即可汇报。',
      tip: '计划可与任务联动，自动追踪完成状态'
    },
    {
      icon: '🔌',
      title: '接入微信消息互通',
      desc: '点击右上角「微信」图标，扫码登录 ClawBot。微信消息会自动入队，处理结果原路回复给用户。',
      tip: '支持空闲提醒和任务完成自动回复'
    }
  ];

  let refreshTimer = null;
  let tourModal = null;
  let currentTourStep = 0;

  async function loadOverview() {
    try {
      const { data } = await api('/api/overview/stats');
      renderStats(data);
      renderTrend(data.trend || []);
      renderSourceDist(data.source_dist || {});
      renderHealth(data.health || {});
      renderRecentTasks(data.recent_tasks || []);
    } catch (e) {
      showNotification(`❌ 概览加载失败: ${e.message}`, 'error');
    }
  }

  function renderStats(d) {
    setStat(
      'tasks',
      d.tasks.total,
      `${d.tasks.pending} 待处理 · ${d.tasks.processing} 进行中 · ${d.tasks.completed} 已完成`
    );
    const rate = d.tasks.success_rate;
    setStat(
      'success_rate',
      rate == null ? '—' : rate + '%',
      rate == null ? '暂无已完成任务' : rate >= 90 ? '🎯 表现优秀' : rate >= 70 ? '⚠️ 关注失败' : '❌ 需排查'
    );
    setStat('kb', d.kb.items, `${d.kb.categories} 分类 · ${d.kb.links} 关联`);
    setStat('sessions', d.sessions.total, `${d.sessions.active} 活跃 · ${d.sessions.archived} 归档`);
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
    if (trend.length === 0 || trend.every((b) => b.count === 0)) {
      el.innerHTML = '<div class="empty-state"><div class="empty-text">暂无趋势数据</div></div>';
      return;
    }
    const max = Math.max(1, ...trend.map((b) => b.count));
    const w = 420,
      h = 160,
      pad = 24;
    const bw = (w - pad * 2) / trend.length;
    const totalColor = 'var(--bg-3)';
    const successColor = 'var(--success)';
    const bars = trend
      .map((b, i) => {
        const bh = (b.count / max) * (h - pad * 2);
        const x = pad + i * bw;
        const y = h - pad - bh;
        const successH = b.count > 0 ? (b.success / b.count) * bh : 0;
        return `
        <g>
          <rect x="${x + 3}" y="${y}" width="${bw - 6}" height="${bh}" rx="4" fill="${totalColor}"/>
          <rect x="${x + 3}" y="${y}" width="${bw - 6}" height="${successH}" rx="4" fill="${successColor}"/>
          <text x="${x + bw / 2}" y="${h - 6}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${b.date.slice(5)}</text>
          <text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="var(--text)" font-weight="600">${b.count}</text>
        </g>
      `;
      })
      .join('');
    el.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
        <text x="${pad}" y="16" font-size="11" fill="var(--text-muted)">⬛ 总任务  🟩 成功</text>
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
        const pct = Math.round((count / total) * 100);
        const color = SOURCE_COLOR[src] || 'var(--text-muted)';
        return `
          <div class="source-row">
            <span class="source-label">${SOURCE_LABEL[src] || src}</span>
            <div class="source-bar"><div class="source-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="source-count">${count} (${pct}%)</span>
          </div>
        `;
      })
      .join('');
    el.innerHTML = rows;
  }

  function renderHealth(h) {
    const el = document.getElementById('overview-health');
    if (!el) return;
    const upMin = Math.floor(h.server_uptime_sec / 60);
    const upStr = upMin < 60 ? `${upMin} 分钟` : `${Math.floor(upMin / 60)} 小时 ${upMin % 60} 分`;
    const clawIcon = h.claw.connected ? '✅' : h.claw.enabled ? '⏳' : '⏸';
    const clawState = h.claw.connected ? '已登录' : h.claw.enabled ? h.claw.state : '未启用';
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

  function renderRecentTasks(list) {
    const el = document.getElementById('overview-activity-list');
    const cnt = document.getElementById('overview-activity-count');
    if (cnt) cnt.textContent = `${list.length} 条`;
    if (!el) return;
    if (list.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-text">暂无最近活动</div></div>';
      return;
    }
    el.innerHTML = `<div class="activity-list">${list
      .map((t) => {
        const ts = new Date(t.ts);
        const timeStr = isNaN(ts.getTime())
          ? ''
          : (() => {
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
      })
      .join('')}</div>`;
    el.querySelectorAll('.activity-row').forEach((row) => {
      row.addEventListener('click', () => {
        const tid = row.dataset.taskId;
        if (tid && global.Tasks && global.Tasks.selectTask) {
          global.Tasks.selectTask(tid);
          if (global.Main && global.Main.switchTab) global.Main.switchTab('chat');
        }
      });
    });
  }

  // ======== 新用户上手弹框 ========
  function openTourModal() {
    if (tourModal) {
      tourModal.remove();
      tourModal = null;
    }
    currentTourStep = 0;
    tourModal = document.createElement('div');
    tourModal.className = 'modal-overlay tour-modal-overlay';
    tourModal.setAttribute('role', 'dialog');
    tourModal.setAttribute('aria-modal', 'true');
    tourModal.setAttribute('aria-label', '新用户上手');
    document.body.appendChild(tourModal);
    renderTourStep();

    tourModal.addEventListener('click', (e) => {
      if (e.target === tourModal) closeTourModal();
    });
    document.addEventListener('keydown', handleTourKey);
  }

  function closeTourModal() {
    document.removeEventListener('keydown', handleTourKey);
    if (tourModal) {
      tourModal.remove();
      tourModal = null;
    }
  }

  function handleTourKey(e) {
    if (e.key === 'Escape') closeTourModal();
    if (e.key === 'ArrowRight') nextTourStep();
    if (e.key === 'ArrowLeft') prevTourStep();
  }

  function renderTourStep() {
    if (!tourModal) return;
    const step = TOUR_STEPS[currentTourStep];
    const total = TOUR_STEPS.length;
    const dots = TOUR_STEPS.map(
      (_, i) => `<span class="tour-dot ${i === currentTourStep ? 'active' : ''}" data-idx="${i}"></span>`
    ).join('');

    tourModal.innerHTML = `
      <div class="tour-modal">
        <button class="tour-modal-close" aria-label="关闭">×</button>
        <div class="tour-modal-body">
          <div class="tour-visual">${step.icon}</div>
          <div class="tour-step-number">步骤 ${currentTourStep + 1} / ${total}</div>
          <h3 class="tour-title">${escapeHtml(step.title)}</h3>
          <p class="tour-desc">${escapeHtml(step.desc)}</p>
          <div class="tour-tip">💡 ${escapeHtml(step.tip)}</div>
        </div>
        <div class="tour-modal-footer">
          <div class="tour-dots">${dots}</div>
          <div class="tour-actions">
            <button class="btn-secondary ${currentTourStep === 0 ? 'hidden' : ''}" id="btn-tour-prev">上一步</button>
            ${
              currentTourStep === total - 1
                ? '<button class="btn-primary" id="btn-tour-finish">完成</button>'
                : '<button class="btn-primary" id="btn-tour-next">下一步</button>'
            }
          </div>
        </div>
      </div>
    `;

    tourModal.querySelector('.tour-modal-close')?.addEventListener('click', closeTourModal);
    tourModal.querySelector('#btn-tour-prev')?.addEventListener('click', prevTourStep);
    tourModal.querySelector('#btn-tour-next')?.addEventListener('click', nextTourStep);
    tourModal.querySelector('#btn-tour-finish')?.addEventListener('click', closeTourModal);
    tourModal.querySelectorAll('.tour-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        currentTourStep = parseInt(dot.dataset.idx, 10);
        renderTourStep();
      });
    });
  }

  function nextTourStep() {
    if (currentTourStep < TOUR_STEPS.length - 1) {
      currentTourStep++;
      renderTourStep();
    }
  }

  function prevTourStep() {
    if (currentTourStep > 0) {
      currentTourStep--;
      renderTourStep();
    }
  }

  function bindOverviewEvents() {
    const tour = document.getElementById('btn-overview-tour');
    if (tour) tour.addEventListener('click', openTourModal);

    document.querySelectorAll('.quick-card').forEach((btn) => {
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
          if (input) input.focus();
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
      const panel = document.getElementById('panel-overview');
      if (panel && !panel.hidden) loadOverview();
    }, 30000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function initOverview() {
    bindOverviewEvents();
    startAutoRefresh();
    loadOverview();
  }

  global.Overview = {
    init: initOverview,
    load: loadOverview,
    startAutoRefresh,
    stopAutoRefresh
  };
})(window);
