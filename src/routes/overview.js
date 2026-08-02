import express from 'express';
import { generateWeeklyInsight } from '../ai-chat.js';
import { isAiAvailable } from '../ai.js';

/**
 * 总览 KPI / 趋势 / 周报。挂载于 /api/overview。
 * presence 推导（不落库）：last_heartbeat_at 或 mcp_session_at ≤15s→online；
 * >60s→offline；其间→idle；有 processing 任务→busy。
 */
export default function (ctx) {
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;

  function presenceOf(agent, processingAgentIds, nowSec) {
    if (processingAgentIds.has(agent.id)) return 'busy';
    const last = Math.max(agent.last_heartbeat_at || 0, agent.mcp_session_at || 0);
    if (!last) return 'offline';
    const diff = nowSec - last;
    if (diff <= 15) return 'online';
    if (diff <= 60) return 'idle';
    return 'offline';
  }

  const dayKey = (ts) => {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  router.get('/', ru, (req, res) => {
    const nowSec = util.now();
    const tasks = store.coll('tasks').all();
    const today = dayKey(nowSec);
    const weekAgo = nowSec - 7 * 86400;

    const todayTasks = tasks.filter((t) => dayKey(t.created_at) === today).length;
    const weekDone = tasks.filter((t) => t.completed_at && t.completed_at >= weekAgo);
    const success = weekDone.filter((t) => t.status === 'completed').length;
    const failed = weekDone.filter((t) => t.status === 'failed').length;
    const successRate = success + failed > 0 ? Math.round((success / (success + failed)) * 100) / 100 : null;

    // 近 7 天趋势（按 completed_at 分桶）
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const key = dayKey(nowSec - i * 86400);
      trend.push({
        date: key,
        completed: tasks.filter((t) => t.status === 'completed' && t.completed_at && dayKey(t.completed_at) === key).length,
        failed: tasks.filter((t) => t.status === 'failed' && t.completed_at && dayKey(t.completed_at) === key).length,
      });
    }

    const processingAgentIds = new Set(
      tasks.filter((t) => t.status === 'processing' && t.assigned_to).map((t) => t.assigned_to)
    );
    const agentCounts = { online: 0, busy: 0, offline: 0, pending_review: 0 };
    for (const a of store.coll('agents').all()) {
      if (a.review_status === 'pending_review') { agentCounts.pending_review++; continue; }
      const p = presenceOf(a, processingAgentIds, nowSec);
      if (p === 'busy') agentCounts.busy++;
      else if (p === 'offline') agentCounts.offline++;
      else agentCounts.online++; // online / idle 均计入在线
    }

    res.json({
      today_tasks: todayTasks,
      success_rate: successRate,
      agents: agentCounts,
      trend,
      queue_depth: tasks.filter((t) => t.status === 'pending').length,
    });
  });

  router.get('/weekly-report', ru, async (req, res) => {
    const nowSec = util.now();
    const weekAgo = nowSec - 7 * 86400;
    const tasks = store.coll('tasks').all().filter((t) => t.created_at >= weekAgo);
    const agents = store.coll('agents');

    const SOURCE_LABEL = {
      manual: '手动创建', chat: '对话', wechat: '微信',
      scheduled: '定时任务', workflow: '工作流', delegation: '智能体委派',
    };
    const bySource = {};
    for (const t of tasks) bySource[t.source] = (bySource[t.source] || 0) + 1;

    const byAgent = {};
    for (const t of tasks) {
      if (!t.assigned_to) continue;
      const name = agents.get(t.assigned_to)?.name || t.assigned_to;
      byAgent[name] = byAgent[name] || { total: 0, success: 0, failed: 0 };
      byAgent[name].total++;
      if (t.status === 'completed') byAgent[name].success++;
      if (t.status === 'failed') byAgent[name].failed++;
    }

    const done = tasks.filter((t) => t.status === 'completed').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const rate = done + failed > 0 ? ((done / (done + failed)) * 100).toFixed(1) : '—';

    // Top 失败原因（按 result.summary 聚合）
    const failReasons = {};
    for (const t of tasks) {
      if (t.status !== 'failed') continue;
      const reason = String(t.result?.summary || '（未提供原因）').slice(0, 60);
      failReasons[reason] = (failReasons[reason] || 0) + 1;
    }
    const topFailures = Object.entries(failReasons).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const stats = {
      total: tasks.length,
      completed: done,
      failed,
      success_rate: rate,
      by_source: bySource,
      by_agent: byAgent,
      top_failures: topFailures,
    };

    let insight = '';
    if (await isAiAvailable(ctx, 'report')) {
      insight = await generateWeeklyInsight(ctx, stats);
    }

    const lines = [
      `# ai-bridge 周报（${dayKey(weekAgo)} ~ ${dayKey(nowSec)}）`,
      '',
      insight ? `## 本周洞察\n${insight}\n` : '',
      `## 概览`,
      `- 本周任务总数：${tasks.length}`,
      `- 已完成：${done}，失败：${failed}，成功率：${rate}%`,
      `- 当前排队：${store.coll('tasks').all().filter((t) => t.status === 'pending').length}`,
      '',
      '## 按来源统计',
      ...Object.entries(bySource).map(([s, n]) => `- ${SOURCE_LABEL[s] || s}：${n}`),
      '',
      '## 按智能体统计',
      ...(Object.keys(byAgent).length
        ? Object.entries(byAgent).map(([n, s]) => `- ${n}：共 ${s.total}，成功 ${s.success}，失败 ${s.failed}`)
        : ['- （本周无智能体执行记录）']),
      '',
      '## Top 失败原因',
      ...(topFailures.length
        ? topFailures.map(([r, n], i) => `${i + 1}. ${r}（${n} 次）`)
        : ['- （本周无失败任务）']),
      '',
    ].filter(Boolean);
    res.json({ markdown: lines.join('\n') });
  });

  return router;
}
