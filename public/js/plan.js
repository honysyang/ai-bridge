// ======== v5.2.0 计划与周报模块 ========
//
// 计划 CRUD、筛选、周报生成、提醒调度器。

(function (global) {
  'use strict';

  const { state, api, escapeHtml, showNotification } = global.Core;
  function openDrawer(id) {
    if (global.Main && global.Main.openDrawer) global.Main.openDrawer(id);
  }
  function closeDrawer(id) {
    if (global.Main && global.Main.closeDrawer) global.Main.closeDrawer(id);
  }

  // ======== 常量 ========
  const PLAN_STORAGE_KEY = 'ai_bridge_plans_v1';
  const PLAN_PRIORITY_LABEL = { low: '低', normal: '普通', high: '高' };
  const PLAN_STATUS_LABEL = {
    pending: '⏳ 待开始',
    in_progress: '⚙️ 进行中',
    done: '✅ 已完成',
    cancelled: '❌ 已取消'
  };
  const PLAN_TYPE_LABEL = { day: '日计划', week: '周计划' };

  // ======== localStorage 工具 ========
  function loadPlansFromStorage() {
    try {
      const raw = localStorage.getItem(PLAN_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function savePlansToStorage(plans) {
    try {
      localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans));
    } catch (e) {
      console.error('[plan] localStorage 保存失败:', e);
    }
  }

  function generatePlanId() {
    return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // ======== 日期工具 ========
  function getISOWeekRange(date = new Date()) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay() || 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const iso = (d1) => d1.toISOString().slice(0, 10);
    const weekNum = getISOWeekNumber(d);
    return {
      start: iso(monday),
      end: iso(sunday),
      label: `W${String(weekNum).padStart(2, '0')} ${monday.getMonth() + 1}/${monday.getDate()}-${sunday.getMonth() + 1}/${sunday.getDate()}`
    };
  }

  function getISOWeekNumber(d) {
    const date = new Date(d);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
    const week1 = new Date(date.getFullYear(), 0, 4);
    return 1 + Math.round(((date - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  }

  function getNextWeekRange() {
    const cur = getISOWeekRange();
    const start = new Date(cur.start);
    start.setDate(start.getDate() + 7);
    const end = new Date(cur.end);
    end.setDate(end.getDate() + 7);
    const iso = (d1) => d1.toISOString().slice(0, 10);
    return { start: iso(start), end: iso(end) };
  }

  function inDateRange(dateStr, startStr, endStr) {
    return dateStr >= startStr && dateStr <= endStr;
  }

  function isCurrentWeek(dateStr) {
    const { start, end } = getISOWeekRange();
    return inDateRange(dateStr, start, end);
  }

  function isNextWeek(dateStr) {
    const { start, end } = getNextWeekRange();
    return inDateRange(dateStr, start, end);
  }

  // ======== Init ========
  function initPlan() {
    state.plans = loadPlansFromStorage();

    const searchInput = document.getElementById('plan-search');
    if (searchInput)
      searchInput.addEventListener('input', (e) => {
        state.planFilter.search = e.target.value;
        renderPlans();
      });
    const typeFilter = document.getElementById('plan-type-filter');
    if (typeFilter)
      typeFilter.addEventListener('change', (e) => {
        state.planFilter.type = e.target.value;
        renderPlans();
      });
    const statusFilter = document.getElementById('plan-status-filter');
    if (statusFilter)
      statusFilter.addEventListener('change', (e) => {
        state.planFilter.status = e.target.value;
        renderPlans();
      });
    const weekFilter = document.getElementById('plan-week-filter');
    if (weekFilter)
      weekFilter.addEventListener('change', (e) => {
        state.planFilter.week = e.target.value;
        renderPlans();
      });

    const btnNew = document.getElementById('btn-plan-new');
    if (btnNew) btnNew.addEventListener('click', () => openPlanDrawer(null));
    const btnSeed = document.getElementById('btn-plan-seed-demo');
    if (btnSeed) btnSeed.addEventListener('click', seedPlanDemo);
    const btnSeed2 = document.getElementById('btn-plan-seed-demo-2');
    if (btnSeed2) btnSeed2.addEventListener('click', seedPlanDemo);

    const drawerSave = document.getElementById('plan-drawer-save');
    if (drawerSave) drawerSave.addEventListener('click', savePlanFromDrawer);
    const drawerCancel = document.getElementById('plan-drawer-cancel');
    if (drawerCancel) drawerCancel.addEventListener('click', () => closeDrawer('plan-drawer'));
    const drawerDelete = document.getElementById('plan-drawer-delete');
    if (drawerDelete) drawerDelete.addEventListener('click', deletePlanFromDrawer);

    renderPlans();
    if (global.Main && global.Main.updateTabCounts) global.Main.updateTabCounts();
  }

  function getFilteredPlans() {
    const f = state.planFilter;
    return (state.plans || [])
      .filter((p) => {
        if (f.type !== 'all' && p.type !== f.type) return false;
        if (f.status !== 'all' && p.status !== f.status) return false;
        if (f.week === 'current' && !isCurrentWeek(p.date)) return false;
        if (f.week === 'next' && !isNextWeek(p.date)) return false;
        if (f.search) {
          const q = f.search.toLowerCase();
          const hay = `${p.title} ${p.details || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        const pr = { high: 0, normal: 1, low: 2 };
        const da = pr[a.priority] ?? 1;
        const db = pr[b.priority] ?? 1;
        if (da !== db) return da - db;
        return a.created_at - b.created_at;
      });
  }

  function renderPlans() {
    const sideEl = document.getElementById('plan-side');
    const mainEl = document.getElementById('plan-main');
    const emptyEl = document.getElementById('plan-empty');
    if (!sideEl || !mainEl) return;

    const filtered = getFilteredPlans();

    if (!state.plans || state.plans.length === 0) {
      sideEl.innerHTML = '';
      mainEl.innerHTML = '';
      mainEl.appendChild(emptyEl);
      if (emptyEl) emptyEl.style.display = '';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const groups = { week: [], day: [] };
    for (const p of filtered) {
      if (groups[p.type]) groups[p.type].push(p);
    }

    let sideHtml = '';
    for (const type of ['week', 'day']) {
      if (groups[type].length === 0) continue;
      sideHtml += `
        <div class="plan-group-title">
          <span>${type === 'week' ? '📆 周计划' : '📅 日计划'}</span>
          <span class="count">${groups[type].length}</span>
        </div>`;
      for (const p of groups[type]) {
        const isActive = p.id === state.currentPlanId;
        const hasRemind = !!p.remind_at;
        const isOverdue = hasRemind && !p.notified_at && p.remind_at < Date.now();
        const isUpcoming =
          hasRemind && !p.notified_at && p.remind_at >= Date.now() && p.remind_at - Date.now() < 24 * 3600 * 1000;
        const remindBadge = isOverdue
          ? '<span class="badge badge-overdue">🚨 已到期</span>'
          : isUpcoming
            ? '<span class="badge badge-upcoming">⏰ 即将到期</span>'
            : hasRemind
              ? '<span class="badge badge-remind">⏰ 已设提醒</span>'
              : '';
        sideHtml += `
          <div class="plan-item ${isActive ? 'active' : ''} ${isOverdue ? 'overdue' : ''}" data-plan-id="${escapeHtml(p.id)}">
            <div class="plan-item-row">
              <span class="plan-item-title">${escapeHtml(p.title)}</span>
              <span class="plan-item-date">${escapeHtml(p.date.slice(5))}</span>
            </div>
            <div class="plan-item-meta">
              <span class="badge status-${escapeHtml(p.status)}">${escapeHtml(PLAN_STATUS_LABEL[p.status] || p.status)}</span>
              <span class="badge priority-${escapeHtml(p.priority)}">${escapeHtml(PLAN_PRIORITY_LABEL[p.priority] || p.priority)}</span>
              ${remindBadge}
            </div>
          </div>`;
      }
    }
    if (!sideHtml) {
      sideHtml = `<div class="empty-state" style="padding:24px"><div class="empty-text">没有匹配的计划</div><div class="empty-hint">调整筛选条件试试</div></div>`;
    }
    sideEl.innerHTML = sideHtml;

    sideEl.querySelectorAll('.plan-item').forEach((el) => {
      el.addEventListener('click', () => selectPlan(el.dataset.planId));
    });

    if (state.currentPlanId) {
      const p = state.plans.find((x) => x.id === state.currentPlanId);
      if (p) {
        renderPlanDetail(p);
        return;
      }
    }
    mainEl.innerHTML = `
      <div class="plan-empty">
        <div class="empty-icon">👈</div>
        <div class="empty-text">选择计划查看详情</div>
        <div class="empty-hint">左侧列表里点击，或「+ 新建计划」</div>
      </div>`;
  }

  function selectPlan(id) {
    state.currentPlanId = id;
    renderPlans();
  }

  function renderPlanDetail(p) {
    const mainEl = document.getElementById('plan-main');
    if (!mainEl) return;
    const createdAt = new Date(p.created_at).toLocaleString('zh-CN');
    const updatedAt = p.updated_at ? new Date(p.updated_at).toLocaleString('zh-CN') : createdAt;
    mainEl.innerHTML = `
      <div class="plan-detail">
        <div class="plan-detail-header">
          <div class="plan-detail-title">${escapeHtml(p.title)}</div>
          <div class="plan-detail-meta">
            <span class="badge">${escapeHtml(PLAN_TYPE_LABEL[p.type] || p.type)}</span>
            <span class="badge">📅 ${escapeHtml(p.date)}</span>
            <span class="badge">${escapeHtml(PLAN_STATUS_LABEL[p.status] || p.status)}</span>
            <span class="badge">优先级: ${escapeHtml(PLAN_PRIORITY_LABEL[p.priority] || p.priority)}</span>
          </div>
        </div>
        <div class="plan-detail-body">${escapeHtml(p.details || '')}</div>
        <div class="plan-detail-actions">
          <button class="btn-secondary" id="plan-detail-edit">✎ 编辑</button>
          <button class="btn-secondary" id="plan-detail-status-toggle">${p.status === 'done' ? '↺ 重新打开' : '✓ 标记完成'}</button>
          <button class="btn-danger" id="plan-detail-delete">🗑 删除</button>
        </div>
        <div style="padding:8px 28px 24px;font-size:11px;color:#9ca3af;">
          创建: ${escapeHtml(createdAt)} · 更新: ${escapeHtml(updatedAt)}
        </div>
      </div>`;

    const editBtn = document.getElementById('plan-detail-edit');
    if (editBtn) editBtn.addEventListener('click', () => openPlanDrawer(p.id));
    const statusBtn = document.getElementById('plan-detail-status-toggle');
    if (statusBtn) statusBtn.addEventListener('click', () => togglePlanStatus(p.id));
    const delBtn = document.getElementById('plan-detail-delete');
    if (delBtn)
      delBtn.addEventListener('click', async () => {
        const ok = await global.Core.openConfirm({
          title: '删除计划',
          message: '确认删除此计划？',
          confirmText: '删除',
          danger: true
        });
        if (!ok) return;
        state.plans = state.plans.filter((x) => x.id !== p.id);
        savePlansToStorage(state.plans);
        state.currentPlanId = null;
        renderPlans();
        if (global.Main && global.Main.updateTabCounts) global.Main.updateTabCounts();
        showNotification('✓ 已删除', 'success');
      });
  }

  function togglePlanStatus(id) {
    const p = state.plans.find((x) => x.id === id);
    if (!p) return;
    p.status = p.status === 'done' ? 'in_progress' : 'done';
    p.updated_at = Date.now();
    savePlansToStorage(state.plans);
    renderPlans();
    showNotification(p.status === 'done' ? '✓ 已标记完成' : '↺ 已重新打开', 'success');
  }

  function openPlanDrawer(planId) {
    const drawer = document.getElementById('plan-drawer');
    if (!drawer) return;
    const today = new Date().toISOString().slice(0, 10);
    const p = planId ? state.plans.find((x) => x.id === planId) : null;
    drawer.dataset.planId = p ? p.id : '';

    document.getElementById('plan-drawer-title').textContent = p ? '✎ 编辑计划' : '📅 新建计划';
    document.getElementById('plan-drawer-title-input').value = p ? p.title : '';
    document.getElementById('plan-drawer-type-select').value = p ? p.type : 'day';
    document.getElementById('plan-drawer-date-input').value = p ? p.date : today;
    document.getElementById('plan-drawer-status-select').value = p ? p.status : 'pending';
    document.getElementById('plan-drawer-priority-select').value = p ? p.priority : 'normal';
    document.getElementById('plan-drawer-details-input').value = p ? p.details || '' : '';
    document.getElementById('plan-drawer-remind-input').value =
      p && p.remind_at ? new Date(p.remind_at).toISOString().slice(0, 16) : '';
    document.getElementById('plan-drawer-remind-inapp').checked =
      !p || !p.remind_channels || p.remind_channels.includes('inapp');
    document.getElementById('plan-drawer-remind-wechat').checked =
      p && p.remind_channels && p.remind_channels.includes('wechat');
    document.getElementById('plan-drawer-meta').textContent = p
      ? `创建于 ${new Date(p.created_at).toLocaleString('zh-CN')}` +
        (p.notified_at ? ` · 已提醒于 ${new Date(p.notified_at).toLocaleString('zh-CN')}` : '')
      : '';
    document.getElementById('plan-drawer-delete').style.display = p ? '' : 'none';
    document.getElementById('plan-drawer-title-input').focus();

    openDrawer('plan-drawer');
  }

  function savePlanFromDrawer() {
    const drawer = document.getElementById('plan-drawer');
    if (!drawer) return;
    const id = drawer.dataset.planId;
    const title = document.getElementById('plan-drawer-title-input').value.trim();
    const type = document.getElementById('plan-drawer-type-select').value;
    const date = document.getElementById('plan-drawer-date-input').value;
    const status = document.getElementById('plan-drawer-status-select').value;
    const priority = document.getElementById('plan-drawer-priority-select').value;
    const details = document.getElementById('plan-drawer-details-input').value.trim();
    const remindRaw = document.getElementById('plan-drawer-remind-input').value;
    const remind_at = remindRaw ? new Date(remindRaw).getTime() : null;
    const remind_channels = [];
    if (document.getElementById('plan-drawer-remind-inapp').checked) remind_channels.push('inapp');
    if (document.getElementById('plan-drawer-remind-wechat').checked) remind_channels.push('wechat');

    if (!title) return showNotification('❌ 标题不能为空', 'error');
    if (!date) return showNotification('❌ 日期不能为空', 'error');

    if (id) {
      const p = state.plans.find((x) => x.id === id);
      if (p) {
        p.title = title;
        p.type = type;
        p.date = date;
        p.status = status;
        p.priority = priority;
        p.details = details;
        p.remind_at = remind_at;
        p.remind_channels = remind_channels.length > 0 ? remind_channels : undefined;
        p.notified_at = null;
        p.updated_at = Date.now();
      }
      showNotification('✓ 已更新', 'success');
    } else {
      state.plans.push({
        id: generatePlanId(),
        title,
        type,
        date,
        status,
        priority,
        details,
        remind_at,
        remind_channels: remind_channels.length > 0 ? remind_channels : undefined,
        notified_at: null,
        created_at: Date.now(),
        updated_at: Date.now()
      });
      showNotification('✓ 已创建', 'success');
    }

    savePlansToStorage(state.plans);
    closeDrawer('plan-drawer');
    renderPlans();
    if (global.Main && global.Main.updateTabCounts) global.Main.updateTabCounts();
    if (remind_at) {
      showNotification(`⏰ 已设置提醒：${new Date(remind_at).toLocaleString('zh-CN')}`, 'success');
    }
  }

  async function deletePlanFromDrawer() {
    const drawer = document.getElementById('plan-drawer');
    if (!drawer) return;
    const id = drawer.dataset.planId;
    if (!id) return;
    const ok = await global.Core.openConfirm({
      title: '删除计划',
      message: '确认删除此计划？',
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    state.plans = state.plans.filter((x) => x.id !== id);
    savePlansToStorage(state.plans);
    closeDrawer('plan-drawer');
    state.currentPlanId = null;
    renderPlans();
    if (global.Main && global.Main.updateTabCounts) global.Main.updateTabCounts();
    showNotification('✓ 已删除', 'success');
  }

  async function seedPlanDemo() {
    if (state.plans && state.plans.length > 0) {
      const ok = await global.Core.openConfirm({
        title: '加载示例计划',
        message: `已有 ${state.plans.length} 条计划，继续将追加 8 条示例。是否继续？`,
        confirmText: '继续'
      });
      if (!ok) return;
    }

    const cur = getISOWeekRange();
    const nxt = getNextWeekRange();
    const now = Date.now();
    const dayOffset = (weekStart, offset) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };

    const seedPlans = [
      {
        id: generatePlanId(),
        type: 'week',
        date: cur.start,
        title: '本周重点：完成知识库重构 & 修复 3 个 P1 bug',
        details: '周计划：\n• 推进知识库 2.0 架构\n• 修复 3 个 P1 缺陷\n• 周三 14:00 团队同步\n• 周五 16:00 周报',
        status: 'in_progress',
        priority: 'high',
        created_at: now,
        updated_at: now
      },
      {
        id: generatePlanId(),
        type: 'day',
        date: dayOffset(cur.start, 0),
        title: '代码审查：PR #158 (知识库 store 重构)',
        details: '重点看：\n1. JSONL append-only\n2. transition() 状态机\n3. 错误处理',
        status: 'done',
        priority: 'high',
        created_at: now,
        updated_at: now
      },
      {
        id: generatePlanId(),
        type: 'day',
        date: dayOffset(cur.start, 1),
        title: '修复工单 #421：iLink 投递失败',
        details: '复现：连续发 3 条 → 合并/丢弃。\n临时：per-wxid 串行 worker。',
        status: 'in_progress',
        priority: 'high',
        created_at: now,
        updated_at: now
      },
      {
        id: generatePlanId(),
        type: 'day',
        date: dayOffset(cur.start, 2),
        title: '团队周中同步会议',
        details: '议程：\n1. 本周进度\n2. P1 缺陷\n3. 下周计划',
        status: 'pending',
        priority: 'normal',
        created_at: now,
        updated_at: now
      },
      {
        id: generatePlanId(),
        type: 'day',
        date: dayOffset(cur.start, 3),
        title: '修复工单 #423：cytoscape 内联样式',
        details: '原因：cytoscape 3.x 不支持 elements[] 内联 style。\n方案：移到 cy.style()。',
        status: 'pending',
        priority: 'normal',
        created_at: now,
        updated_at: now
      },
      {
        id: generatePlanId(),
        type: 'day',
        date: dayOffset(cur.start, 4),
        title: '周报 + 下周计划',
        details: '周报：\n1. 本周完成\n2. 进行中\n3. 风险\n4. 下周计划',
        status: 'pending',
        priority: 'normal',
        created_at: now,
        updated_at: now
      },
      {
        id: generatePlanId(),
        type: 'week',
        date: nxt.start,
        title: '下周重点：发布 v5.1 + 启动 v6.0 规划',
        details: '周计划：\n• v5.1 发布\n• 启动 v6.0 规划\n• 周二 10:00 产品评审',
        status: 'pending',
        priority: 'normal',
        created_at: now,
        updated_at: now
      },
      {
        id: generatePlanId(),
        type: 'day',
        date: dayOffset(nxt.start, 0),
        title: 'v5.1 发布检查清单',
        details: '1. 演示数据完整\n2. 文档更新\n3. 单元测试 > 60%\n4. 性能压测',
        status: 'pending',
        priority: 'high',
        created_at: now,
        updated_at: now
      }
    ];

    state.plans = (state.plans || []).concat(seedPlans);
    savePlansToStorage(state.plans);
    state.planFilter.week = 'all';
    state.planFilter.type = 'all';
    document.getElementById('plan-week-filter').value = 'all';
    document.getElementById('plan-type-filter').value = 'all';
    renderPlans();
    if (global.Main && global.Main.updateTabCounts) global.Main.updateTabCounts();
    showNotification(`✓ 已加载 ${seedPlans.length} 条演示计划`, 'success');
  }

  // ======== 周报生成器 ========
  function getReportWeekRange(which = 'current') {
    if (which === 'last') {
      const cur = getISOWeekRange();
      const start = new Date(cur.start);
      start.setDate(start.getDate() - 7);
      const end = new Date(cur.end);
      end.setDate(end.getDate() - 7);
      const iso = (d) => d.toISOString().slice(0, 10);
      return {
        start: iso(start),
        end: iso(end),
        label: `上周 ${start.getMonth() + 1}/${start.getDate()}-${end.getMonth() + 1}/${end.getDate()}`
      };
    }
    if (which === 'next') {
      const nxt = getNextWeekRange();
      return {
        start: nxt.start,
        end: nxt.end,
        label: `下周 ${new Date(nxt.start).getMonth() + 1}/${new Date(nxt.start).getDate()}-${new Date(nxt.end).getMonth() + 1}/${new Date(nxt.end).getDate()}`
      };
    }
    const cur = getISOWeekRange();
    return { start: cur.start, end: cur.end, label: `本周 ${cur.label.split(' ').slice(1).join(' ')}` };
  }

  async function generateWeeklyReport(which) {
    const range = getReportWeekRange(which);
    const sections = {
      summary: document.getElementById('report-sec-summary')?.checked,
      plans: document.getElementById('report-sec-plans')?.checked,
      progress: document.getElementById('report-sec-progress')?.checked,
      tasks: document.getElementById('report-sec-tasks')?.checked,
      kb: document.getElementById('report-sec-kb')?.checked,
      next: document.getElementById('report-sec-next')?.checked,
      tips: document.getElementById('report-sec-tips')?.checked
    };

    const lines = [];
    lines.push(`# 周报 · ${range.label}`);
    lines.push('');
    lines.push(`> 生成时间: ${new Date().toLocaleString('zh-CN')}`);
    lines.push(`> 数据范围: ${range.start} ~ ${range.end}`);
    lines.push('');

    const allPlans = state.plans || [];
    const inRange = (p) => p.date >= range.start && p.date <= range.end;
    const inWeek = (p) => {
      if (p.type === 'week') return p.date >= range.start && p.date <= range.end;
      return inRange(p);
    };
    const weekPlans = allPlans.filter(inWeek);
    const donePlans = weekPlans.filter((p) => p.status === 'done');
    const inProgressPlans = weekPlans.filter((p) => p.status === 'in_progress');
    const pendingPlans = weekPlans.filter((p) => p.status === 'pending');
    const cancelledPlans = weekPlans.filter((p) => p.status === 'cancelled');

    let completedTasks = [];
    let taskStats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
    try {
      const sinceMs = new Date(range.start).getTime();
      const res = await fetch(`/api/tasks?since=${sinceMs}&limit=200`);
      const json = await res.json();
      if (json.success) {
        const all = json.data || [];
        taskStats = json.meta?.queue_stats || taskStats;
        completedTasks = all.filter((t) => t.status === 'completed' || t.status === 'failed');
      }
    } catch (e) {
      console.warn('[weekly-report] 获取任务失败:', e);
    }

    let kbNew = 0;
    if (sections.kb) {
      try {
        const res = await fetch('/api/kb');
        const json = await res.json();
        if (json.success) {
          const sinceMs = new Date(range.start).getTime();
          const items = json.data?.items || [];
          kbNew = items.filter((it) => (it.created_at || 0) >= sinceMs).length;
        }
      } catch (e) {
        /* 静默失败 */
      }
    }

    if (sections.summary) {
      const completionRate = weekPlans.length > 0 ? Math.round((donePlans.length / weekPlans.length) * 100) : 0;
      lines.push('## 📊 数据总览');
      lines.push('');
      lines.push(`| 指标 | 数值 |`);
      lines.push(`|------|------|`);
      lines.push(`| 计划总数 | ${weekPlans.length} |`);
      lines.push(`| 已完成 | ${donePlans.length} (${completionRate}%) |`);
      lines.push(`| 进行中 | ${inProgressPlans.length} |`);
      lines.push(`| 待开始 | ${pendingPlans.length} |`);
      lines.push(`| 已取消 | ${cancelledPlans.length} |`);
      lines.push(`| 完成任务 | ${taskStats.completed || 0} |`);
      lines.push(`| 失败任务 | ${taskStats.failed || 0} |`);
      if (sections.kb) lines.push(`| 知识库新增 | ${kbNew} |`);
      lines.push('');
    }

    if (sections.plans) {
      lines.push('## ✅ 本周完成');
      lines.push('');
      if (donePlans.length === 0) {
        lines.push('_本周无完成的计划_');
      } else {
        for (const p of donePlans) {
          const pri = PLAN_PRIORITY_LABEL[p.priority] || p.priority;
          lines.push(`- [x] **${p.title}** _(${pri})_`);
        }
      }
      lines.push('');
    }

    if (sections.progress) {
      lines.push('## ⚙️ 进行中');
      lines.push('');
      if (inProgressPlans.length === 0) {
        lines.push('_无进行中的计划_');
      } else {
        for (const p of inProgressPlans) {
          const pri = PLAN_PRIORITY_LABEL[p.priority] || p.priority;
          lines.push(`- [ ] **${p.title}** _(${pri})_`);
        }
      }
      lines.push('');
    }

    if (sections.tasks) {
      lines.push('## 📨 完成任务');
      lines.push('');
      if (completedTasks.length === 0) {
        lines.push('_本周无完成的任务_');
      } else {
        const top = completedTasks.slice(0, 10);
        for (const t of top) {
          const content = (t.data?.content || '').slice(0, 60).replace(/\n/g, ' ');
          const summary = t.result?.result?.summary || '';
          const ok = t.status === 'completed' ? '✅' : '❌';
          lines.push(`- ${ok} ${content}${summary ? ` → ${summary.slice(0, 50)}` : ''}`);
        }
        if (completedTasks.length > 10) {
          lines.push(`- _...及其他 ${completedTasks.length - 10} 条_`);
        }
      }
      lines.push('');
    }

    if (sections.next) {
      lines.push('## 🎯 下周计划');
      lines.push('');
      if (pendingPlans.length === 0) {
        lines.push('_无待开始的计划_');
      } else {
        for (const p of pendingPlans) {
          const pri = PLAN_PRIORITY_LABEL[p.priority] || p.priority;
          lines.push(`- [ ] **${p.title}** _(${pri})_`);
        }
      }
      lines.push('');
    }

    if (sections.tips) {
      const tips = [];
      const completionRate = weekPlans.length > 0 ? Math.round((donePlans.length / weekPlans.length) * 100) : 0;
      if (weekPlans.length > 0 && completionRate < 50) {
        tips.push(`完成率 ${completionRate}%，建议拆解大任务或调整优先级`);
      }
      if (inProgressPlans.length > 5) {
        tips.push(`进行中任务 ${inProgressPlans.length} 个偏多，建议聚焦 3 个核心`);
      }
      if (cancelledPlans.length > weekPlans.length * 0.3) {
        tips.push(`取消率偏高，需审视计划制定质量`);
      }
      if (tips.length === 0) {
        tips.push('本周执行健康，继续保持节奏 ✨');
      }
      lines.push('## 💡 改进建议');
      lines.push('');
      for (const t of tips) {
        lines.push(`- ${t}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async function openWeeklyReportDrawer() {
    const drawer = document.getElementById('report-drawer');
    if (!drawer) return;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.getElementById('drawer-overlay')?.classList.add('open');
    await generateAndFillReport();
  }

  async function generateAndFillReport() {
    const output = document.getElementById('report-output');
    const meta = document.getElementById('report-meta');
    const which = document.getElementById('report-week-select')?.value || 'current';

    if (output) output.value = '⏳ 正在汇总数据...';
    if (meta) meta.textContent = '';
    const copyBtn = document.getElementById('report-copy');
    const dlBtn = document.getElementById('report-download');
    if (copyBtn) copyBtn.disabled = true;
    if (dlBtn) dlBtn.disabled = true;

    try {
      const t0 = Date.now();
      const md = await generateWeeklyReport(which);
      const took = Date.now() - t0;
      if (output) output.value = md;
      if (meta) meta.textContent = `✓ 生成完成，耗时 ${took}ms，长度 ${md.length} 字符`;
      if (copyBtn) copyBtn.disabled = false;
      if (dlBtn) dlBtn.disabled = false;
    } catch (e) {
      if (output) output.value = `❌ 生成失败：${e.message}`;
      if (meta) meta.textContent = '';
    }
  }

  async function copyWeeklyReport() {
    const output = document.getElementById('report-output');
    if (!output || !output.value) return;
    try {
      await navigator.clipboard.writeText(output.value);
      showNotification('✓ 已复制到剪贴板', 'success');
    } catch (e) {
      output.select();
      document.execCommand('copy');
      showNotification('✓ 已复制（兼容模式）', 'success');
    }
  }

  function downloadWeeklyReport() {
    const output = document.getElementById('report-output');
    if (!output || !output.value) return;
    const which = document.getElementById('report-week-select')?.value || 'current';
    const range = getReportWeekRange(which);
    const filename = `周报-${range.start}_${range.end}.md`;
    const blob = new Blob([output.value], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showNotification(`✓ 已下载 ${filename}`, 'success');
  }

  function initReportDrawer() {
    const btnOpen = document.getElementById('btn-plan-report');
    if (btnOpen) btnOpen.addEventListener('click', openWeeklyReportDrawer);
    const btnGen = document.getElementById('report-generate');
    if (btnGen) btnGen.addEventListener('click', generateAndFillReport);
    const btnCopy = document.getElementById('report-copy');
    if (btnCopy) btnCopy.addEventListener('click', copyWeeklyReport);
    const btnDl = document.getElementById('report-download');
    if (btnDl) btnDl.addEventListener('click', downloadWeeklyReport);
    const sel = document.getElementById('report-week-select');
    if (sel) sel.addEventListener('change', generateAndFillReport);
  }

  // ======== 计划提醒调度器 ========
  function startPlanReminderScheduler() {
    if (global.Core.planReminderTimer) return;
    checkPlanReminders();
    global.Core.planReminderTimer = setInterval(checkPlanReminders, 30_000);
    console.log('[plan-reminder] 调度器已启动（每 30s 扫描）');
  }

  async function checkPlanReminders() {
    const now = Date.now();
    const plans = state.plans || [];
    const due = plans.filter(
      (p) => p.remind_at && p.remind_at <= now && !p.notified_at && p.status !== 'done' && p.status !== 'cancelled'
    );
    if (due.length === 0) return;
    console.log(`[plan-reminder] 发现 ${due.length} 个到期提醒`);
    for (const p of due) {
      await dispatchPlanReminder(p);
      p.notified_at = now;
    }
    savePlansToStorage(plans);
    renderPlans();
  }

  async function dispatchPlanReminder(plan) {
    const text = `⏰ 计划提醒：${plan.title}\n${plan.details || ''}\n\n时间：${new Date(plan.remind_at).toLocaleString('zh-CN')}`;
    const channels = plan.remind_channels || ['inapp'];

    if (channels.includes('inapp')) {
      showNotification(text, 'info', 8000);
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('📅 计划提醒', { body: plan.title, tag: `plan-${plan.id}` });
        } else if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission().then((p) => {
            if (p === 'granted') {
              new Notification('📅 计划提醒', { body: plan.title, tag: `plan-${plan.id}` });
            }
          });
        }
      } catch (e) {
        console.warn('[plan-reminder] Notification API 失败:', e);
      }
    }

    if (channels.includes('wechat')) {
      try {
        const wxid = (state.claw && state.claw.status && state.claw.status.wxid) || null;
        if (!wxid) {
          console.warn('[plan-reminder] 无可用 wxid，跳过微信推送');
          showNotification('⚠️ 微信未连接，跳过微信推送', 'warn');
          return;
        }
        const resp = await fetch('/api/claw/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wxid, content: text })
        });
        const json = await resp.json();
        if (json.success) {
          console.log(`[plan-reminder] 微信推送成功: ${wxid}`);
          showNotification('✓ 微信提醒已发送', 'success');
        } else {
          console.warn(`[plan-reminder] 微信推送失败: ${json.error}`);
        }
      } catch (e) {
        console.error('[plan-reminder] 微信推送异常:', e);
      }
    }
  }

  // 暴露到 window
  global.Plan = {
    initPlan,
    initReportDrawer,
    startPlanReminderScheduler,
    openWeeklyReportDrawer,
    generateWeeklyReport,
    generateAndFillReport,
    openPlanDrawer,
    savePlanFromDrawer,
    deletePlanFromDrawer,
    seedPlanDemo,
    renderPlans,
    selectPlan,
    togglePlanStatus,
    loadPlansFromStorage,
    savePlansToStorage,
    getISOWeekRange,
    getReportWeekRange,
    checkPlanReminders,
    dispatchPlanReminder
  };
})(window);
