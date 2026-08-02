import express from 'express';

/**
 * 定时任务规则 + 调度器 tick。挂载于 /api/schedules。
 * index.js 每 30s 调用一次导出的 tick(ctx)。
 */

/** 生成一条 scheduled 任务并推进 next_run */
function fireSchedule(ctx, schedule) {
  const { store, events, util } = ctx;
  const nowSec = util.now();
  const task = store.coll('tasks').insert({
    id: util.uid('task'),
    type: 'generate_content',
    priority: 'normal',
    source: 'scheduled',
    data: { content: schedule.content_template, extra: { schedule_id: schedule.id } },
    status: 'pending',
    target_agent: schedule.target_agent || undefined,
    required_capability: schedule.required_capability || undefined,
    created_at: nowSec,
  });
  events.emit('task:changed', task);
  // 推进 next_run：基于上次 next_run 累加，若仍落后则跳到 now+interval，避免补发堆积
  const interval = Math.max(1, Number(schedule.interval_minutes) || 1) * 60;
  let next = (schedule.next_run || nowSec) + interval;
  if (next <= nowSec) next = nowSec + interval;
  store.coll('schedules').update(schedule.id, { last_run: nowSec, next_run: next });
  store.log('info', 'scheduler', `定时规则「${schedule.name}」触发，生成任务 ${task.id}`);
  return task;
}

/** 调度器入口：由 index.js 每 30s 调用 */
export function tick(ctx) {
  const { store, util } = ctx;
  const nowSec = util.now();
  for (const s of store.coll('schedules').all()) {
    if (s.enabled && s.next_run && s.next_run <= nowSec) fireSchedule(ctx, s);
  }
}

export default function (ctx) {
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;
  const schedules = () => store.coll('schedules');

  const calcNext = (intervalMinutes) => util.now() + Math.max(1, Number(intervalMinutes) || 1) * 60;

  router.get('/', ru, (req, res) => {
    res.json(schedules().all().sort((a, b) => a.created_at - b.created_at));
  });

  router.post('/', ru, (req, res) => {
    const { name, content_template, interval_minutes } = req.body || {};
    if (!name || !content_template || !interval_minutes) {
      return res.status(400).json({ error: 'name, content_template, interval_minutes required' });
    }
    const enabled = req.body.enabled !== false;
    const s = schedules().insert({
      id: util.uid('schedule'),
      name: String(name),
      content_template: String(content_template),
      target_agent: req.body.target_agent || undefined,
      required_capability: req.body.required_capability || undefined,
      interval_minutes: Number(interval_minutes),
      enabled,
      next_run: enabled ? calcNext(interval_minutes) : undefined,
      created_at: util.now(),
    });
    res.status(201).json(s);
  });

  router.patch('/:id', ru, (req, res) => {
    const s = schedules().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    for (const k of ['name', 'content_template', 'target_agent', 'required_capability']) {
      if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    let interval = s.interval_minutes;
    if (req.body?.interval_minutes !== undefined) {
      interval = Number(req.body.interval_minutes);
      patch.interval_minutes = interval;
      patch.next_run = calcNext(interval); // 间隔变化重新计算
    }
    if (req.body?.enabled !== undefined) {
      patch.enabled = !!req.body.enabled;
      // 启用时重新计算 next_run；禁用时清空
      patch.next_run = patch.enabled ? calcNext(interval) : undefined;
    }
    // 显式指定 next_run 时优先采用（前端"立即执行"、smoke 置过去时间均依赖此语义）
    if (req.body?.next_run !== undefined) {
      patch.next_run = Number(req.body.next_run);
      if (patch.enabled === undefined) patch.enabled = true;
    }
    res.json(schedules().update(s.id, patch));
  });

  router.delete('/:id', ru, (req, res) => {
    const s = schedules().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    schedules().remove(s.id);
    res.json({ ok: true });
  });

  // 测试辅助：立即触发一次
  router.post('/:id/run-now', ru, (req, res) => {
    const s = schedules().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const task = fireSchedule(ctx, s);
    res.status(201).json({ task });
  });

  return router;
}
