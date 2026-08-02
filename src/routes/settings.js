import express from 'express';

/**
 * 设置：AI 模型 / 系统信息 / 日志 / 用户管理。挂载于 /api。
 */
export default function (ctx) {
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;
  const ra = ctx.auth.requireAdmin;

  // ---- AI 模型配置 ----
  router.get('/settings/ai-models', ru, (req, res) => {
    res.json({
      ...store.getSetting('ai_models', { models: [] }),
      ai_routing: store.getSetting('ai_routing', {}),
    });
  });

  router.patch('/settings/ai-models', ru, (req, res) => {
    const models = req.body?.models;
    if (!Array.isArray(models)) return res.status(400).json({ error: 'models must be an array' });
    for (const m of models) {
      if (!m || !m.name || !m.provider) return res.status(400).json({ error: 'each model requires name and provider' });
    }
    const val = {
      models: models.map((m) => ({
        name: String(m.name), provider: String(m.provider),
        base_url: m.base_url || '', model: m.model || '', api_key: m.api_key || '',
      })),
    };
    store.setSetting('ai_models', val);

    // 保存 AI 用途绑定
    if (req.body?.ai_routing !== undefined && req.body.ai_routing !== null) {
      const routing = {};
      for (const purpose of ['compress', 'route', 'report', 'qa', 'default']) {
        const v = req.body.ai_routing[purpose];
        if (typeof v === 'string' && v.trim()) routing[purpose] = v.trim();
      }
      store.setSetting('ai_routing', routing);
    }

    res.json({
      ...val,
      ai_routing: store.getSetting('ai_routing', {}),
    });
  });

  // ---- 系统信息 ----
  router.get('/system/info', ru, (req, res) => {
    res.json({
      version: '7.0.0',
      node: process.version,
      uptime: Math.floor(process.uptime()),
      data_dir: store.dataDir,
      tasks_total: store.coll('tasks').count(),
      agents_total: store.coll('agents').count(),
    });
  });

  // ---- 日志 ----
  router.get('/logs', ru, (req, res) => {
    let list = store.coll('logs').all().sort((a, b) => b.at - a.at);
    if (req.query.level) list = list.filter((l) => l.level === req.query.level);
    if (req.query.source) list = list.filter((l) => l.source === req.query.source);
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json(list.slice(0, limit));
  });

  // ---- 用户管理（admin） ----
  const publicUser = (u) => ({ id: u.id, username: u.username, roles: u.roles, created_at: u.created_at });

  router.get('/settings/users', ru, ra, (req, res) => {
    res.json(store.coll('users').all().map(publicUser));
  });

  router.post('/settings/users', ru, ra, (req, res) => {
    const { username, password, roles = [] } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (store.coll('users').find((u) => u.username === username)) {
      return res.status(409).json({ error: 'username exists' });
    }
    const user = store.coll('users').insert({
      id: util.uid('user'), username: String(username),
      password_hash: ctx.auth.hashSecret(String(password)),
      roles: Array.isArray(roles) ? roles : [],
      created_at: util.now(),
    });
    store.log('info', 'auth', `管理员 ${req.user.username} 创建用户 ${username}`);
    res.status(201).json(publicUser(user));
  });

  router.patch('/settings/users/:id', ru, ra, (req, res) => {
    const user = store.coll('users').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    if (req.body?.username !== undefined) patch.username = String(req.body.username);
    if (req.body?.password) patch.password_hash = ctx.auth.hashSecret(String(req.body.password));
    if (req.body?.roles !== undefined) {
      const roles = Array.isArray(req.body.roles) ? req.body.roles : [];
      // 不允许把最后一个 admin 降级
      const admins = store.coll('users').all().filter((u) => u.roles?.includes('admin'));
      if (user.roles?.includes('admin') && !roles.includes('admin') && admins.length === 1) {
        return res.status(400).json({ error: 'cannot demote last admin' });
      }
      patch.roles = roles;
    }
    res.json(publicUser(store.coll('users').update(user.id, patch)));
  });

  router.delete('/settings/users/:id', ru, ra, (req, res) => {
    const user = store.coll('users').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'not_found' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
    const admins = store.coll('users').all().filter((u) => u.roles?.includes('admin'));
    if (user.roles?.includes('admin') && admins.length === 1) {
      return res.status(400).json({ error: 'cannot delete last admin' });
    }
    store.coll('users').remove(user.id);
    store.log('info', 'auth', `管理员 ${req.user.username} 删除用户 ${user.username}`);
    res.json({ ok: true });
  });

  return router;
}
