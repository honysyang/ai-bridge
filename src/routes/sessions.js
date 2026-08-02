import express from 'express';

/**
 * 会话 CRUD。挂载于 /api/sessions。
 * 默认会话 session-default 由 initAuth 播种，不可删除；
 * 删除其他会话时，其任务 session_id 改写为默认会话。
 */
export default function (ctx) {
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;
  const sessions = () => store.coll('sessions');
  const DEFAULT_ID = 'session-default';

  router.get('/', ru, (req, res) => {
    let list = sessions().all().sort((a, b) => a.created_at - b.created_at);
    if (req.query.status) list = list.filter((s) => s.status === req.query.status);
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter((s) => (s.name || '').toLowerCase().includes(q));
    }
    res.json(list);
  });

  router.post('/', ru, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = req.body?.id ? String(req.body.id).trim() : util.uid('session');
    if (sessions().get(id)) return res.status(409).json({ error: 'session id already exists' });
    const session = sessions().insert({
      id, name, status: 'active', created_at: util.now(),
    });
    res.status(201).json(session);
  });

  router.patch('/:id', ru, (req, res) => {
    const s = sessions().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim() || s.name;
    if (req.body?.status !== undefined) {
      if (!['active', 'archived'].includes(req.body.status)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      patch.status = req.body.status;
    }
    res.json(sessions().update(s.id, patch));
  });

  router.delete('/:id', ru, (req, res) => {
    const s = sessions().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (s.id === DEFAULT_ID) return res.status(400).json({ error: 'default_session_protected' });
    // 该会话下的任务归并到默认会话
    const tasks = store.coll('tasks');
    for (const t of tasks.all()) {
      if (t.session_id === s.id) tasks.update(t.id, { session_id: DEFAULT_ID });
    }
    sessions().remove(s.id);
    res.json({ ok: true });
  });

  return router;
}
