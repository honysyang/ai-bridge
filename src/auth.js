import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { uid, now } from './util.js';

let SECRET = null;
let STORE = null;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function hashSecret(s) {
  const iter = 100000;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(s, salt, iter, 32, 'sha256').toString('hex');
  return `pbkdf2$${iter}$${salt}$${hash}`;
}

export function verifySecret(s, stored) {
  try {
    const [, iter, salt, hash] = stored.split('$');
    const calc = crypto.pbkdf2Sync(s, salt, Number(iter), 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  } catch { return false; }
}

export function signToken(payload, ttlSec = 7 * 86400) {
  const body = { ...payload, exp: now() + ttlSec };
  const data = b64u(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  try {
    const [data, sig] = String(token).split('.');
    const expect = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const body = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (body.exp && body.exp < now()) return null;
    return body;
  } catch { return null; }
}

export function agentToken() {
  return 'agt_' + crypto.randomBytes(24).toString('hex');
}

/** 初始化：播种 admin 用户、JWT 密钥、默认会话 */
export function initAuth(store) {
  STORE = store;
  const secretsFile = path.join(store.dataDir, 'secrets.json');
  let secrets = fs.existsSync(secretsFile)
    ? JSON.parse(fs.readFileSync(secretsFile, 'utf8'))
    : {};
  if (!secrets.jwt_secret) {
    secrets.jwt_secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
  }
  SECRET = secrets.jwt_secret;

  const users = store.coll('users');
  if (users.count() === 0) {
    users.insert({
      id: uid('user'), username: 'admin', password_hash: hashSecret('admin123'),
      roles: ['admin'], created_at: now(),
    });
    store.log('info', 'auth', '已播种默认管理员 admin（初始密码 admin123，请尽快修改）');
  }
  const sessions = store.coll('sessions');
  if (!sessions.get('session-default')) {
    sessions.insert({ id: 'session-default', name: '默认会话', status: 'active', created_at: now() });
  }
}

function findAgent(agent_id) {
  return STORE.coll('agents').get(agent_id);
}

/** 用户认证中间件 */
export function requireUser(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = verifyToken(token);
  if (!payload || !payload.uid) return res.status(401).json({ error: 'unauthorized' });
  const user = STORE.coll('users').get(payload.uid);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id: user.id, username: user.username, roles: user.roles || [] };
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.roles?.includes('admin')) return res.status(403).json({ error: 'forbidden' });
  next();
}

/**
 * Agent 凭证中间件。agent_id + token 来自 query 或 body。
 * opts.allowPending=true 时放行非 active 状态（heartbeat 用），其余情况 403。
 */
export function requireAgent(opts = {}) {
  return (req, res, next) => {
    const agent_id = req.query.agent_id || req.body?.agent_id;
    const token = req.query.token || req.body?.token;
    if (!agent_id || !token) return res.status(401).json({ error: 'agent credentials required' });
    const agent = findAgent(agent_id);
    if (!agent || !verifySecret(token, agent.token_hash)) {
      return res.status(401).json({ error: 'invalid agent credentials' });
    }
    req.agent = agent;
    if (!opts.allowPending && agent.review_status !== 'active') {
      return res.status(403).json({ error: agent.review_status });
    }
    next();
  };
}
