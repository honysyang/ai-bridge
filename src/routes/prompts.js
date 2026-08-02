import express from 'express';

/**
 * 提示词库。挂载于 /api/prompts。
 * variables 从 content 的 {{var}} 自动提取；apply 渲染；use 渲染并创建任务。
 */
export default function (ctx) {
  const router = express.Router();
  const { store, events, util } = ctx;
  const ru = ctx.auth.requireUser;
  const prompts = () => store.coll('prompts');

  const extractVars = (content) => {
    const vars = [];
    for (const m of String(content).matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) {
      if (!vars.includes(m[1])) vars.push(m[1]);
    }
    return vars;
  };

  const render = (content, vars = {}) =>
    String(content).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, k) =>
      vars[k] !== undefined ? String(vars[k]) : m);

  router.get('/', ru, (req, res) => {
    res.json(prompts().all().sort((a, b) => a.created_at - b.created_at));
  });

  router.post('/', ru, (req, res) => {
    const { category, name, content } = req.body || {};
    if (!name || !content) return res.status(400).json({ error: 'name and content required' });
    const p = prompts().insert({
      id: util.uid('prompt'),
      category: category || '默认',
      name: String(name),
      content: String(content),
      variables: extractVars(content),
      created_at: util.now(),
    });
    res.status(201).json(p);
  });

  router.patch('/:id', ru, (req, res) => {
    const p = prompts().get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    for (const k of ['category', 'name', 'content']) {
      if (req.body?.[k] !== undefined) patch[k] = String(req.body[k]);
    }
    if (patch.content !== undefined) patch.variables = extractVars(patch.content);
    res.json(prompts().update(p.id, patch));
  });

  router.delete('/:id', ru, (req, res) => {
    const p = prompts().get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    prompts().remove(p.id);
    res.json({ ok: true });
  });

  router.post('/:id/apply', ru, (req, res) => {
    const p = prompts().get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json({ text: render(p.content, req.body?.vars || {}) });
  });

  router.post('/:id/use', ru, (req, res) => {
    const p = prompts().get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    const text = render(p.content, req.body?.vars || {});
    const task = store.coll('tasks').insert({
      id: util.uid('task'),
      type: 'generate_content',
      priority: 'normal',
      source: 'manual',
      data: { content: text, extra: { prompt_id: p.id, prompt_name: p.name } },
      status: 'pending',
      target_agent: req.body?.target_agent || undefined,
      session_id: req.body?.session_id || undefined,
      created_at: util.now(),
    });
    events.emit('task:changed', task);
    res.status(201).json({ task });
  });

  return router;
}
