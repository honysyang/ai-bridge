import express from 'express';

/**
 * 工作流 + 执行 watcher。挂载于 /api/workflows。
 * watcher 订阅 events 'task:changed'：某 run 的 step 任务 completed 后，
 * 释放所有依赖已满足的后续 step；全部完成则 run completed；任一步 failed 则 run failed。
 */
export default function (ctx) {
  const router = express.Router();
  const { store, events, util } = ctx;
  const ru = ctx.auth.requireUser;
  const workflows = () => store.coll('workflows');
  const runs = () => store.coll('workflow_runs');
  const tasks = () => store.coll('tasks');

  /**
   * 渲染步骤内容模板变量：{{steps[N].summary}}
   * 用 run 中已完成前序步骤的 result.summary 替换。
   */
  function renderStepContent(run, workflow, stepIndex) {
    const step = workflow.steps[stepIndex];
    let content = step.content || '';
    const regex = /\{\{\s*steps\[(\d+)\]\.summary\s*\}\}/g;
    const stepTasks = run.step_tasks || {};
    content = content.replace(regex, (match, nStr) => {
      const n = parseInt(nStr, 10);
      if (Number.isNaN(n) || n < 0 || n >= workflow.steps.length) {
        store.log('warn', 'workflow', `步骤 ${stepIndex} 引用越界变量 ${match}`);
        return '';
      }
      const depTaskId = stepTasks[n];
      if (!depTaskId) {
        store.log('warn', 'workflow', `步骤 ${stepIndex} 引用未释放步骤 ${n} 的结果：${match}`);
        return '';
      }
      const depTask = tasks().get(depTaskId);
      if (!depTask || depTask.status !== 'completed') {
        store.log('warn', 'workflow', `步骤 ${stepIndex} 引用步骤 ${n} 的结果未完成：${match}`);
        return '';
      }
      return String(depTask.result?.summary ?? '');
    });
    return content;
  }

  function createStepTask(run, workflow, stepIndex) {
    const step = workflow.steps[stepIndex];
    const content = renderStepContent(run, workflow, stepIndex);
    const task = tasks().insert({
      id: util.uid('task'),
      type: 'multi_step',
      priority: 'normal',
      source: 'workflow',
      data: {
        content,
        extra: { workflow_run_id: run.id, step_index: stepIndex, step_name: step.name },
      },
      status: 'pending',
      required_capability: step.capability || undefined,
      target_agent: step.target_agent || undefined,
      created_at: util.now(),
    });
    events.emit('task:changed', task);
    return task;
  }

  /**
   * 拓扑校验：依赖越界 / 自环 / 循环依赖。
   * 返回 { error: 'invalid_dependency'|'cycle_detected', detail: string } 或 null。
   */
  function validateSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return { error: 'invalid_dependency', detail: 'steps must be a non-empty array' };
    const n = steps.length;
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      if (!s || !s.name || !s.content) return { error: 'invalid_dependency', detail: `step ${i} requires name and content` };
      if (s.depends_on !== undefined && !Array.isArray(s.depends_on)) return { error: 'invalid_dependency', detail: `step ${i} depends_on must be an array` };
      for (const d of s.depends_on || []) {
        if (!Number.isInteger(d) || d < 0 || d >= n || d === i) {
          return { error: 'invalid_dependency', detail: `step ${i} has invalid dependency ${d}` };
        }
      }
    }

    // 循环检测：DFS
    const adj = steps.map((s) => (s.depends_on || []).filter((d) => Number.isInteger(d) && d >= 0 && d < n));
    const seen = new Set();
    const rec = new Set();
    function dfs(i) {
      if (rec.has(i)) return true;
      if (seen.has(i)) return false;
      seen.add(i);
      rec.add(i);
      for (const d of adj[i]) {
        if (dfs(d)) return true;
      }
      rec.delete(i);
      return false;
    }
    for (let i = 0; i < n; i++) {
      if (dfs(i)) return { error: 'cycle_detected', detail: `cycle detected involving step ${i}` };
    }
    return null;
  }

  // ---- watcher：模块内注册一次 ----
  events.on('task:changed', (task) => {
    try {
      const runId = task?.data?.extra?.workflow_run_id;
      if (!runId) return;
      if (task.status !== 'completed' && task.status !== 'failed') return;
      const run = runs().get(runId);
      if (!run || run.status !== 'running') return;
      const workflow = workflows().get(run.workflow_id);
      if (!workflow) return;

      if (task.status === 'failed') {
        runs().update(run.id, { status: 'failed', completed_at: util.now() });
        store.log('warn', 'workflow', `工作流执行 ${run.name} 失败：步骤任务 ${task.id} failed`);
        return;
      }

      // 以事件中携带的任务状态覆盖存储快照（兼容先发射后落库的调用方）
      const getTask = (id) => (id === task.id ? task : tasks().get(id));

      // 释放依赖全部满足的 step
      const stepTasks = { ...(run.step_tasks || {}) };
      let changed = false;
      for (let i = 0; i < workflow.steps.length; i++) {
        if (stepTasks[i]) continue; // 已有任务
        const deps = workflow.steps[i].depends_on || [];
        const ready = deps.every((d) => {
          const dt = stepTasks[d] ? getTask(stepTasks[d]) : null;
          return dt && dt.status === 'completed';
        });
        if (!ready) continue;
        const t = createStepTask(run, workflow, i);
        stepTasks[i] = t.id;
        changed = true;
      }
      if (changed) runs().update(run.id, { step_tasks: stepTasks });

      // 全部 step 已有任务且全部 completed → run completed
      const indices = workflow.steps.map((_, i) => i);
      const allDone = indices.every((i) => {
        const tid = stepTasks[i];
        const t = tid ? getTask(tid) : null;
        return t && t.status === 'completed';
      });
      const anyFailed = indices.some((i) => {
        const tid = stepTasks[i];
        const t = tid ? getTask(tid) : null;
        return t && t.status === 'failed';
      });
      if (anyFailed) {
        runs().update(run.id, { status: 'failed', completed_at: util.now() });
      } else if (allDone) {
        runs().update(run.id, { status: 'completed', completed_at: util.now() });
        store.log('info', 'workflow', `工作流执行 ${run.name} 完成`);
      }
    } catch (e) {
      store.log('error', 'workflow', `watcher 异常: ${e.message}`);
    }
  });

  // ---- CRUD ----
  // 注意：/runs 相关路由必须在 /:id 之前注册
  router.get('/runs', ru, (req, res) => {
    let list = runs().all().sort((a, b) => b.created_at - a.created_at);
    if (req.query.workflow_id) list = list.filter((r) => r.workflow_id === req.query.workflow_id);
    res.json(list);
  });

  router.get('/runs/:id', ru, (req, res) => {
    const run = runs().get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    const workflow = workflows().get(run.workflow_id);
    const steps = (workflow?.steps || []).map((s, i) => {
      const tid = (run.step_tasks || {})[i];
      const t = tid ? tasks().get(tid) : null;
      return {
        index: i,
        name: s.name,
        x: s.x ?? 0,
        y: s.y ?? 0,
        depends_on: s.depends_on || [],
        task_id: tid || null,
        status: t ? t.status : 'waiting',
        task: t || null,
      };
    });
    res.json({ ...run, steps });
  });

  router.get('/', ru, (req, res) => {
    res.json(workflows().all().sort((a, b) => a.created_at - b.created_at));
  });

  function normalizeStep(s) {
    const out = {
      name: String(s.name),
      content: String(s.content),
      depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
    };
    if (s.capability?.trim?.()) out.capability = s.capability.trim();
    if (s.target_agent?.trim?.()) out.target_agent = s.target_agent.trim();
    if (Number.isFinite(s.x)) out.x = Number(s.x);
    if (Number.isFinite(s.y)) out.y = Number(s.y);
    return out;
  }

  router.post('/', ru, (req, res) => {
    const { name, description = '', steps } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const err = validateSteps(steps);
    if (err) return res.status(400).json({ error: err.error, detail: err.detail });
    const wf = workflows().insert({
      id: util.uid('workflow'),
      name: String(name),
      description: String(description),
      steps: steps.map(normalizeStep),
      created_at: util.now(),
    });
    res.status(201).json(wf);
  });

  router.get('/:id', ru, (req, res) => {
    const wf = workflows().get(req.params.id);
    if (!wf) return res.status(404).json({ error: 'not_found' });
    res.json(wf);
  });

  router.patch('/:id', ru, (req, res) => {
    const wf = workflows().get(req.params.id);
    if (!wf) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name);
    if (req.body?.description !== undefined) patch.description = String(req.body.description);
    if (req.body?.steps !== undefined) {
      const err = validateSteps(req.body.steps);
      if (err) return res.status(400).json({ error: err.error, detail: err.detail });
      patch.steps = req.body.steps.map(normalizeStep);
    }
    res.json(workflows().update(wf.id, patch));
  });

  router.delete('/:id', ru, (req, res) => {
    const wf = workflows().get(req.params.id);
    if (!wf) return res.status(404).json({ error: 'not_found' });
    workflows().remove(wf.id);
    res.json({ ok: true });
  });

  router.post('/:id/execute', ru, (req, res) => {
    const wf = workflows().get(req.params.id);
    if (!wf) return res.status(404).json({ error: 'not_found' });
    const run = runs().insert({
      id: util.uid('run'),
      workflow_id: wf.id,
      name: req.body?.name || `${wf.name} #${runs().count()}`,
      status: 'running',
      step_tasks: {},
      created_at: util.now(),
    });
    const stepTasks = {};
    wf.steps.forEach((s, i) => {
      if (!s.depends_on || s.depends_on.length === 0) {
        stepTasks[i] = createStepTask(run, wf, i).id;
      }
    });
    const updated = runs().update(run.id, { step_tasks: stepTasks });
    store.log('info', 'workflow', `工作流 ${wf.name} 开始执行（run ${run.id}）`);
    res.status(201).json(updated);
  });

  return router;
}
