/* ============================================================
   pages/overview.js — 概览：KPI / 7 天趋势 canvas / agent 速览 / 一键周报
   ============================================================ */
import {
  api, toast, escapeHtml, fmtTime, emptyHTML, renderMarkdown, presenceBadge,
} from '../api.js';

export async function render(el, ctx) {
  el.innerHTML = '<div class="loading-line"><span class="spinner"></span> 加载概览数据…</div>';

  let ov = null, agents = [];
  try {
    [ov, agents] = await Promise.all([
      api.get('/api/overview'),
      api.get('/api/agents'),
    ]);
  } catch (err) {
    el.innerHTML = emptyHTML('📊', '概览数据加载失败', err.message);
    return;
  }

  const ag = ov.agents || {};
  const onlineCount = (ag.online || 0) + (ag.busy || 0);
  const pendingReview = ag.pending_review || 0;
  const successRate = ov.success_rate == null ? null : Math.round(ov.success_rate * 100);

  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">今日任务</div>
        <div class="kpi-value">${ov.today_tasks ?? 0}</div>
        <span class="kpi-icon">📥</span>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">成功率（近 7 天）</div>
        <div class="kpi-value">${successRate == null ? '—' : successRate + '<small>%</small>'}</div>
        <span class="kpi-icon">🎯</span>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">在线智能体</div>
        <div class="kpi-value">${onlineCount}<small> / ${(ag.online || 0) + (ag.busy || 0) + (ag.idle || 0) + (ag.offline || 0)} 总数</small></div>
        <span class="kpi-icon">🤖</span>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">待审核智能体</div>
        <div class="kpi-value">${pendingReview}</div>
        <span class="kpi-icon">🟠</span>
        ${pendingReview > 0 ? '<span class="red-dot" title="有待审核智能体"></span>' : ''}
      </div>
      <div class="kpi-card">
        <div class="kpi-label">队列深度（待分配）</div>
        <div class="kpi-value">${ov.queue_depth ?? 0}</div>
        <span class="kpi-icon">📮</span>
      </div>
    </div>

    <div class="card">
      <div class="flex-between mb8">
        <div class="card-title" style="margin:0">📈 近 7 天任务趋势</div>
        <span class="muted" style="font-size:12px">
          <span class="dot dot-green"></span> 已完成 &nbsp;
          <span class="dot dot-red"></span> 失败
        </span>
      </div>
      <canvas id="trendCanvas" class="chart-canvas" height="220"></canvas>
    </div>

    <div class="flex" style="align-items:flex-start; gap:18px; flex-wrap:wrap">
      <div class="card" style="flex:1; min-width:340px">
        <div class="flex-between mb8">
          <div class="card-title" style="margin:0">🤖 智能体状态速览</div>
          <button class="btn btn-sm" id="goAgents">管理 →</button>
        </div>
        <div id="agentQuick"></div>
      </div>
      <div class="card" style="flex:1; min-width:340px">
        <div class="flex-between mb8">
          <div class="card-title" style="margin:0">🗞️ 智能周报</div>
          <button class="btn btn-sm btn-primary" id="weeklyBtn">一键生成本周周报</button>
        </div>
        <div id="weeklyBox">${emptyHTML('🗞️', '点击右上角按钮生成本周任务周报', '按来源 / 智能体统计 + 成功率 + Top 失败原因')}</div>
      </div>
    </div>`;

  drawTrend(el.querySelector('#trendCanvas'), ov.trend || []);
  renderAgentQuick(el.querySelector('#agentQuick'), agents);

  el.querySelector('#goAgents').addEventListener('click', () => ctx.navigate('agents'));
  el.querySelector('#weeklyBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 生成中…';
    const box = el.querySelector('#weeklyBox');
    try {
      const data = await api.get('/api/overview/weekly-report');
      box.innerHTML = renderMarkdown(data.markdown || '（空报告）');
      toast('周报已生成', 'success');
    } catch (err) {
      toast(err.message, 'error');
      box.innerHTML = emptyHTML('⚠️', '周报生成失败', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '一键生成本周周报';
    }
  });

  // 30s 自动刷新 KPI（静默）
  const timer = setInterval(async () => {
    try {
      const fresh = await api.get('/api/overview');
      const cards = el.querySelectorAll('.kpi-value');
      if (!cards.length) return;
      const a2 = fresh.agents || {};
      cards[0].textContent = fresh.today_tasks ?? 0;
      cards[1].innerHTML = fresh.success_rate == null ? '—' : `${Math.round(fresh.success_rate * 100)}<small>%</small>`;
      cards[2].innerHTML = `${(a2.online || 0) + (a2.busy || 0)}<small> / ${(a2.online || 0) + (a2.busy || 0) + (a2.idle || 0) + (a2.offline || 0)} 总数</small>`;
      cards[3].textContent = a2.pending_review || 0;
      cards[4].textContent = fresh.queue_depth ?? 0;
    } catch { /* 静默 */ }
  }, 30000);
  ctx.onCleanup(() => clearInterval(timer));
}

function renderAgentQuick(box, agents) {
  if (!agents.length) {
    box.innerHTML = emptyHTML('🤖', '还没有接入智能体', '前往「智能体 → 接入智能体」查看接入方式');
    return;
  }
  const sorted = [...agents].sort((a, b) => (b.last_heartbeat_at || 0) - (a.last_heartbeat_at || 0));
  box.innerHTML = `<table class="table"><tbody>${sorted.slice(0, 6).map((a) => `
    <tr>
      <td style="width:32%">${escapeHtml(a.name)}</td>
      <td>${presenceBadge(a.presence)}</td>
      <td class="muted">${(a.capabilities || []).slice(0, 3).map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join('') || '-'}</td>
      <td class="faint mono">${a.last_heartbeat_at ? fmtTime(a.last_heartbeat_at) : (a.mcp_session_at ? 'MCP ' + fmtTime(a.mcp_session_at) : '从未心跳')}</td>
    </tr>`).join('')}</tbody></table>
    ${agents.length > 6 ? `<p class="faint mt8" style="font-size:12px">共 ${agents.length} 个，仅显示最近活跃的 6 个</p>` : ''}`;
}

/** canvas 自绘柱状图：completed（绿）/ failed（红）双序列 */
function drawTrend(canvas, trend) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const cssH = 220;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = `${cssH}px`;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, cssW, cssH);

  const padL = 36, padR = 12, padT = 16, padB = 30;
  const w = cssW - padL - padR, h = cssH - padT - padB;
  const maxV = Math.max(1, ...trend.map((t) => Math.max(t.completed || 0, t.failed || 0)));

  // 网格与 Y 轴刻度
  g.strokeStyle = '#ece6dc';
  g.fillStyle = '#a89f92';
  g.font = '11px sans-serif';
  g.textAlign = 'right';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = padT + h - (h * i) / steps;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + w, y); g.stroke();
    g.fillText(String(Math.round((maxV * i) / steps)), padL - 6, y + 4);
  }

  if (!trend.length) {
    g.textAlign = 'center';
    g.fillText('暂无趋势数据', padL + w / 2, padT + h / 2);
    return;
  }

  const slot = w / trend.length;
  const barW = Math.min(18, (slot - 14) / 2);
  trend.forEach((t, i) => {
    const cx = padL + slot * i + slot / 2;
    const bars = [
      { v: t.completed || 0, color: '#7a9a3f' },
      { v: t.failed || 0, color: '#c05b45' },
    ];
    bars.forEach((b, j) => {
      const bh = (b.v / maxV) * (h - 4);
      const x = cx + (j === 0 ? -barW - 2 : 2);
      const y = padT + h - bh;
      g.fillStyle = b.color;
      g.beginPath();
      g.roundRect(x, y, barW, Math.max(bh, b.v > 0 ? 2 : 0), [3, 3, 0, 0]);
      g.fill();
    });
    // X 轴日期标签（后端给 date 形如 '2025-08-01'，取月-日）
    g.fillStyle = '#a89f92';
    g.textAlign = 'center';
    const label = String(t.date || '').slice(5) || t.date || '';
    g.fillText(label, cx, padT + h + 16);
  });
}
