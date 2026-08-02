import express from 'express';
import { findOrCreateCategoryByName, createItem } from './kb.js';

/**
 * 每日订阅。挂载于 /api/subscriptions。
 *
 * 集合 subscriptions：{id, topic, prompt_template, schedule_time("HH:MM"),
 *   target_agent?, push_wxid, save_to_category(分类名), enabled,
 *   push_rule_id?, last_run_at?, last_task_id?, created_at}
 *
 * 执行流程：
 *   1. tick(ctx) 由 index.js 每 30s 调用 → 检查 schedule_time 到点且 enabled
 *      的订阅 → 创建 source='scheduled' 任务（data.extra.subscription_id）
 *   2. 订阅 task:changed 事件 → 任务 completed 时自动创建日报条目
 *      （等价 from-task），存入 save_to_category 分类
 *   3. 推送复用 claw 推送引擎：创建订阅时自动建 push_rule
 *      （events=['completed'], source_filter=['scheduled'], target_wxid）
 *      删除订阅时联动删除该规则
 */

const DEFAULT_CATEGORY = '每日订阅';
const fired = new Set(); // 任务幂等：避免同一 task 多次入库

/** 渲染订阅 prompt：注入 topic 与输出要求 */
function renderPrompt(sub) {
  return `主题：${sub.topic}\n\n${sub.prompt_template || ''}\n\n输出要求：markdown 日报，含 3-5 条要点及来源说明。`;
}

/** HH:MM → 当日秒级时间戳（用于判断是否到点） */
function todayDateKey(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 创建订阅任务（source='scheduled'，data.extra.subscription_id） */
function fireSubscription(ctx, sub) {
  const { store, events, util } = ctx;
  const nowSec = util.now();
  const task = store.coll('tasks').insert({
    id: util.uid('task'),
    type: 'generate_content',
    priority: 'normal',
    source: 'scheduled',
    data: {
      content: renderPrompt(sub),
      extra: { subscription_id: sub.id },
    },
    status: 'pending',
    target_agent: sub.target_agent || undefined,
    created_at: nowSec,
  });
  events.emit('task:changed', task);
  store.coll('subscriptions').update(sub.id, { last_run_at: nowSec, last_task_id: task.id });
  store.log('info', 'subscriptions', `订阅「${sub.topic}」触发，生成任务 ${task.id}`);
  return task;
}

/** 调度器入口：由 index.js 每 30s 调用。检查到点且 enabled 的订阅 */
export function tick(ctx) {
  const { store, util } = ctx;
  const nowSec = util.now();
  const now = new Date(nowSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const curHHMM = `${p(now.getHours())}:${p(now.getMinutes())}`;
  const todayKey = todayDateKey(nowSec);
  for (const sub of store.coll('subscriptions').all()) {
    if (!sub.enabled) continue;
    if (sub.schedule_time !== curHHMM) continue;
    // 当天已执行过则跳过（last_run_at 同日不重发）
    if (sub.last_run_at && todayDateKey(sub.last_run_at) === todayKey) continue;
    try { fireSubscription(ctx, sub); } catch (e) {
      ctx.store.log('error', 'subscriptions', `订阅 ${sub.id} 触发失败：${e.message}`);
    }
  }
}

/**
 * 注册 task:changed 监听：订阅任务 completed → 自动建日报条目。
 * 在路由模块首次加载时调用（幂等）。
 */
let listenerRegistered = false;
function ensureTaskListener(ctx) {
  if (listenerRegistered) return;
  listenerRegistered = true;
  ctx.events.on('task:changed', (task) => {
    try {
      if (!task || task.status !== 'completed') return;
      const subId = task.data?.extra?.subscription_id;
      if (!subId) return;
      const dedupKey = `${task.id}:sub`;
      if (fired.has(dedupKey)) return;
      fired.add(dedupKey);
      const sub = ctx.store.coll('subscriptions').get(subId);
      if (!sub) return;
      // 找/建目标分类
      const catName = sub.save_to_category || DEFAULT_CATEGORY;
      const cat = findOrCreateCategoryByName(ctx, catName);
      // 组装日报内容
      const question = task.data?.content || '';
      const summary = task.result?.summary || '（无结果摘要）';
      const evidence = task.result?.evidence || {};
      const commands = (evidence.executed_commands || []).map((c) => `- \`${c}\``).join('\n') || '（无）';
      const dateStr = todayDateKey(task.completed_at || ctx.util.now());
      const title = `${sub.topic} 日报 ${dateStr}`;
      const content = `## 订阅主题\n\n${sub.topic}\n\n## 采集指令\n\n${question}\n\n## 日报内容\n\n${summary}\n\n## 执行证据\n\n- 关键命令：\n${commands}`;
      const item = createItem(ctx, {
        category_id: cat?.id,
        title,
        content,
        tags: ['每日订阅', sub.topic],
        extra: { subscription_id: sub.id, source_task_id: task.id },
      });
      ctx.store.log('info', 'subscriptions', `订阅「${sub.topic}」日报已入库：${item.id}`);
    } catch (e) {
      ctx.store.log('error', 'subscriptions', `订阅日报入库失败：${e.message}`);
    }
  });
}

export default function (ctx) {
  ensureTaskListener(ctx);
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;
  const subs = () => store.coll('subscriptions');
  const rules = () => store.coll('push_rules');

  // ---- GET / 列表（附最近一期状态）----
  router.get('/', ru, (req, res) => {
    const list = subs().all().sort((a, b) => b.created_at - a.created_at);
    // 实时附最近一期任务状态
    const tasks = store.coll('tasks');
    for (const s of list) {
      if (s.last_task_id) {
        const t = tasks.get(s.last_task_id);
        s.last_status = t ? t.status : null;
      } else {
        s.last_status = null;
      }
    }
    res.json(list);
  });

  // ---- GET /:id ----
  router.get('/:id', ru, (req, res) => {
    const s = subs().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    // 附该订阅产生的日报条目
    const items = store.coll('kb').all()
      .filter((x) => x.kind === 'item' && x.extra?.subscription_id === s.id)
      .sort((a, b) => b.created_at - a.created_at);
    res.json({ ...s, items });
  });

  // ---- POST / 新建订阅（自动创建对应 push_rule）----
  router.post('/', ru, (req, res) => {
    const { topic, prompt_template, schedule_time, target_agent, push_wxid, save_to_category } = req.body || {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'topic required' });
    }
    if (!schedule_time || !/^\d{2}:\d{2}$/.test(schedule_time)) {
      return res.status(400).json({ error: 'schedule_time 必须为 HH:MM 格式' });
    }
    if (target_agent && !store.coll('agents').get(target_agent)) {
      return res.status(404).json({ error: 'target_agent not_found' });
    }
    const id = util.uid('sub');
    const sub = subs().insert({
      id,
      topic: String(topic),
      prompt_template: String(prompt_template || ''),
      schedule_time: String(schedule_time),
      target_agent: target_agent || undefined,
      push_wxid: String(push_wxid || ''),
      save_to_category: String(save_to_category || DEFAULT_CATEGORY),
      enabled: req.body.enabled !== false,
      created_at: util.now(),
    });

    // 自动创建/更新对应 push_rule（events=['completed'], source_filter=['scheduled']）
    let ruleId = sub.push_rule_id || null;
    if (sub.push_wxid) {
      const rule = rules().insert({
        id: util.uid('rule'),
        name: `订阅：${sub.topic}`,
        events: ['completed'],
        source_filter: ['scheduled'],
        target_wxid: sub.push_wxid,
        enabled: sub.enabled,
      });
      ruleId = rule.id;
      subs().update(id, { push_rule_id: ruleId });
    }

    store.log('info', 'subscriptions', `新建订阅「${sub.topic}」，推送规则 ${ruleId || '（无）'}`);
    res.status(201).json(subs().get(id));
  });

  // ---- PATCH /:id ----
  router.patch('/:id', ru, (req, res) => {
    const s = subs().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    for (const k of ['topic', 'prompt_template', 'schedule_time', 'target_agent', 'push_wxid', 'save_to_category']) {
      if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    if (req.body?.enabled !== undefined) {
      patch.enabled = !!req.body.enabled;
      // 同步更新 push_rule 启停
      if (s.push_rule_id) rules().update(s.push_rule_id, { enabled: patch.enabled });
    }
    // push_wxid 变化时同步更新 push_rule
    if (req.body?.push_wxid !== undefined && s.push_rule_id) {
      rules().update(s.push_rule_id, { target_wxid: String(req.body.push_wxid) });
    }
    const updated = subs().update(s.id, patch);
    res.json(updated);
  });

  // ---- DELETE /:id（联动删除 push_rule）----
  router.delete('/:id', ru, (req, res) => {
    const s = subs().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    // 联动删除 push_rule
    if (s.push_rule_id) {
      const rule = rules().get(s.push_rule_id);
      if (rule) rules().remove(s.push_rule_id);
    }
    subs().remove(s.id);
    store.log('info', 'subscriptions', `已删除订阅「${s.topic}」及其推送规则`);
    res.json({ ok: true });
  });

  // ---- POST /:id/run-now 立即执行一次 ----
  router.post('/:id/run-now', ru, (req, res) => {
    const s = subs().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const task = fireSubscription(ctx, s);
    res.status(201).json({ task });
  });

  return router;
}
