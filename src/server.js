import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import { uid, now } from './util.js';
import * as ai from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * 动态挂载：路由模块存在才加载（允许各模块独立开发期间部分缺失）。
 */
async function mountIfExists(app, file, mountPath, ctx) {
  const full = path.join(__dirname, 'routes', file);
  if (!fs.existsSync(full)) {
    console.warn(`[server] 路由模块缺失，跳过挂载 ${mountPath} (${file})`);
    return;
  }
  const mod = await import(`./routes/${file}`);
  const router = mod.default(ctx);
  app.use(mountPath, router);
}

export async function createServer(store) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  const events = new EventEmitter();
  events.setMaxListeners(50);
  const ctx = {
    store,
    events,
    ai,
    auth: {
      requireUser: auth.requireUser,
      requireAdmin: auth.requireAdmin,
      requireAgent: auth.requireAgent,
      signToken: auth.signToken,
      verifyToken: auth.verifyToken,
      hashSecret: auth.hashSecret,
      verifySecret: auth.verifySecret,
      agentToken: auth.agentToken,
    },
    util: { uid, now },
  };

  // ---- 内联：健康检查与登录 ----
  app.get('/health', (req, res) => res.json({ ok: true, version: '7.0.0', time: now() }));

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = store.coll('users').find((u) => u.username === username);
    if (!user || !auth.verifySecret(password || '', user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    store.log('info', 'auth', `用户 ${username} 登录`);
    res.json({ token: auth.signToken({ uid: user.id }), user: { id: user.id, username: user.username, roles: user.roles } });
  });

  // ---- 内联：skill 文档（接入页签用） ----
  app.get('/api/system/skill', auth.requireUser, (req, res) => {
    const p = path.join(ROOT, 'docs', 'ai-bridge.skill.md');
    const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# ai-bridge skill\n（docs/ai-bridge.skill.md 尚未生成）';
    res.json({ content });
  });

  // ---- 开放/agent 通道 ----
  await mountIfExists(app, 'agents.js', '/api', ctx);
  await mountIfExists(app, 'tasks.js', '/api', ctx);
  await mountIfExists(app, 'mcp.js', '/', ctx);

  // ---- 用户侧功能模块 ----
  await mountIfExists(app, 'sessions.js', '/api/sessions', ctx);
  await mountIfExists(app, 'chat.js', '/api/chat', ctx);
  await mountIfExists(app, 'kb.js', '/api/kb', ctx);
  await mountIfExists(app, 'kb-sources.js', '/api/kb-sources', ctx);
  await mountIfExists(app, 'prompts.js', '/api/prompts', ctx);
  await mountIfExists(app, 'skills.js', '/api/skills', ctx);
  await mountIfExists(app, 'mcp-registry.js', '/api/mcp-registry', ctx);
  await mountIfExists(app, 'workflows.js', '/api/workflows', ctx);
  await mountIfExists(app, 'schedules.js', '/api/schedules', ctx);
  await mountIfExists(app, 'subscriptions.js', '/api/subscriptions', ctx);
  await mountIfExists(app, 'claw.js', '/api/claw', ctx);
  await mountIfExists(app, 'files.js', '/api', ctx);
  await mountIfExists(app, 'overview.js', '/api/overview', ctx);
  await mountIfExists(app, 'settings.js', '/api', ctx);

  // ---- 静态资源 ----
  app.use(express.static(path.join(ROOT, 'public')));
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  // 统一错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    store.log('error', 'http', `${req.method} ${req.path}: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return { app, events, ctx };
}
