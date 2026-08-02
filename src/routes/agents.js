import express from 'express';

/**
 * agents.js —— Agent 注册 / 心跳 / 管理（SPEC §4）
 * 挂载于 /api。
 */

// ---- 注册限流：每 IP 每分钟 10 次（内存 Map）----
const buckets = new Map(); // ip -> [ts]
export function registerRateOk(ip) {
  const t = Date.now();
  let arr = (buckets.get(ip) || []).filter((x) => t - x < 60_000);
  if (arr.length >= 10) {
    buckets.set(ip, arr);
    return false;
  }
  arr.push(t);
  buckets.set(ip, arr);
  return true;
}

/** presence 推导（实时计算，不落库，SPEC §3） */
export function presenceOf(agent, tasksColl, nowSec) {
  const ts = Math.max(agent.last_heartbeat_at || 0, agent.mcp_session_at || 0);
  const age = ts ? nowSec - ts : Infinity;
  let presence;
  if (age <= 15) presence = 'online';
  else if (age > 60) presence = 'offline';
  else presence = 'idle';
  if (presence !== 'offline') {
    const busy = tasksColl.find((t) => t.status === 'processing' && t.assigned_to === agent.id);
    if (busy) presence = 'busy';
  }
  return presence;
}

/** 输出前脱敏 */
function publicAgent(agent) {
  if (!agent) return agent;
  const { token_hash, ...rest } = agent;
  return rest;
}

const REVIEW_ACTIONS = { approve: 'active', reject: 'rejected', disable: 'disabled', enable: 'active' };

export default function (ctx) {
  const { store, events, auth, util } = ctx;
  const router = express.Router();

  // ---- POST /api/agent/register（开放 + 限流）----
  router.post('/agent/register', (req, res) => {
    if (!registerRateOk(req.ip)) {
      return res.status(429).json({ error: 'rate_limited', message: '注册过于频繁，请稍后再试' });
    }
    const { name, capabilities = [], host = '', skill_version = '', connection_type = 'skill' } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    const token = auth.agentToken();
    const agent = {
      id: util.uid('agent'),
      name: String(name).slice(0, 100),
      review_status: 'pending_review',
      connection_type: connection_type === 'mcp' ? 'mcp' : 'skill',
      capabilities: Array.isArray(capabilities) ? capabilities.map(String) : [],
      host: String(host || ''),
      skill_version: String(skill_version || ''),
      token_hash: auth.hashSecret(token),
      created_at: util.now(),
      last_heartbeat_at: null,
      mcp_session_at: null,
      stats: { total: 0, success: 0 },
      installed_skills: [],
    };
    store.coll('agents').insert(agent);
    store.log('info', 'agents', `新 agent 注册：${agent.name} (${agent.id})，等待审核`);
    res.status(201).json({ agent_id: agent.id, token, review_status: agent.review_status });
  });

  // ---- GET /api/heartbeat（任何 review_status 均放行）----
  router.get('/heartbeat', auth.requireAgent({ allowPending: true }), (req, res) => {
    const updated = store.coll('agents').update(req.agent.id, { last_heartbeat_at: util.now() });
    res.json({ ok: true, review_status: updated.review_status, server_time: util.now() });
  });

  // ---- GET /api/agents（requireUser，附 presence）----
  router.get('/agents', auth.requireUser, (req, res) => {
    const tasks = store.coll('tasks');
    const nowSec = util.now();
    const list = store.coll('agents').all().map((a) => ({
      ...publicAgent(a),
      presence: presenceOf(a, tasks, nowSec),
    }));
    res.json(list);
  });

  // ---- POST /api/agents（admin：创建 MCP 预发 agent，直接 active）----
  router.post('/agents', auth.requireUser, auth.requireAdmin, (req, res) => {
    const { name, capabilities = [] } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    const token = auth.agentToken();
    const agent = {
      id: util.uid('agent'),
      name: String(name).slice(0, 100),
      review_status: 'active',
      connection_type: 'mcp',
      capabilities: Array.isArray(capabilities) ? capabilities.map(String) : [],
      host: '',
      skill_version: '',
      token_hash: auth.hashSecret(token),
      created_at: util.now(),
      last_heartbeat_at: null,
      mcp_session_at: null,
      stats: { total: 0, success: 0 },
      installed_skills: [],
    };
    store.coll('agents').insert(agent);
    store.log('info', 'agents', `admin 创建 MCP 预发 agent：${agent.name} (${agent.id})`);
    const url = `http://${req.headers.host}/mcp`;
    res.status(201).json({
      agent_id: agent.id,
      token,
      review_status: agent.review_status,
      mcp_config: {
        mcpServers: {
          'ai-bridge': {
            url,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
    });
  });

  // ---- PATCH /api/agents/:id（admin：审核动作 或 改名/改能力）----
  router.patch('/agents/:id', auth.requireUser, auth.requireAdmin, (req, res) => {
    const coll = store.coll('agents');
    const agent = coll.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    const { action, name, capabilities } = req.body || {};
    const patch = {};
    if (action) {
      const nextStatus = REVIEW_ACTIONS[action];
      if (!nextStatus) return res.status(400).json({ error: 'unknown action', allowed: Object.keys(REVIEW_ACTIONS) });
      patch.review_status = nextStatus;
    }
    if (name !== undefined) {
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'invalid name' });
      patch.name = String(name).slice(0, 100);
    }
    if (capabilities !== undefined) {
      if (!Array.isArray(capabilities)) return res.status(400).json({ error: 'capabilities must be array' });
      patch.capabilities = capabilities.map(String);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    const updated = coll.update(agent.id, patch);
    events.emit('agent:changed', publicAgent(updated));
    store.log('info', 'agents', `agent ${agent.id} 更新：${JSON.stringify(patch)}`);
    res.json({ ...publicAgent(updated), presence: presenceOf(updated, store.coll('tasks'), util.now()) });
  });

  // ---- POST /api/agents/:id/token/reset（admin）----
  router.post('/agents/:id/token/reset', auth.requireUser, auth.requireAdmin, (req, res) => {
    const coll = store.coll('agents');
    const agent = coll.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    const token = auth.agentToken();
    coll.update(agent.id, { token_hash: auth.hashSecret(token) });
    store.log('info', 'agents', `agent ${agent.id} token 已重置`);
    res.json({ agent_id: agent.id, token });
  });

  // ---- DELETE /api/agents/:id（admin）----
  router.delete('/agents/:id', auth.requireUser, auth.requireAdmin, (req, res) => {
    const coll = store.coll('agents');
    const agent = coll.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    coll.remove(agent.id);
    events.emit('agent:changed', { ...publicAgent(agent), deleted: true });
    store.log('info', 'agents', `agent ${agent.id} (${agent.name}) 已删除`);
    res.json({ ok: true });
  });

  // ---- POST /api/agents/:id/install-skill（admin：为 agent 安装技能，固化到 installed_skills）----
  router.post('/agents/:id/install-skill', auth.requireUser, auth.requireAdmin, (req, res) => {
    const coll = store.coll('agents');
    const agent = coll.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    const skillId = req.body?.skill_id;
    if (!skillId) return res.status(400).json({ error: 'skill_id required' });
    const skill = store.coll('skills').get(skillId);
    if (!skill) return res.status(404).json({ error: 'skill not found' });
    if (skill.status !== 'active') return res.status(400).json({ error: 'skill is not active' });

    const installed = agent.installed_skills || [];
    if (installed.some((s) => s.skill_id === skillId)) {
      return res.status(409).json({ error: 'skill already installed' });
    }
    installed.push({
      skill_id: skillId,
      skill_name: skill.name,
      display_name: skill.display_name,
      installed_at: util.now(),
    });
    const updated = coll.update(agent.id, { installed_skills: installed });

    // 技能安装计数 +1
    const skillColl = store.coll('skills');
    const sc = skillColl.get(skillId);
    if (sc) skillColl.update(skillId, { install_count: (sc.install_count || 0) + 1 });

    store.log('info', 'agents', `agent ${agent.name} 安装技能 ${skill.name}`);
    res.json({ ...publicAgent(updated), presence: presenceOf(updated, store.coll('tasks'), util.now()) });
  });

  // ---- DELETE /api/agents/:id/install-skill/:skill_id（admin：卸载技能）----
  router.delete('/agents/:id/install-skill/:skill_id', auth.requireUser, auth.requireAdmin, (req, res) => {
    const coll = store.coll('agents');
    const agent = coll.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    const installed = (agent.installed_skills || []).filter((s) => s.skill_id !== req.params.skill_id);
    const updated = coll.update(agent.id, { installed_skills: installed });

    // 技能安装计数 -1（不低于 0）
    const skillColl = store.coll('skills');
    const sc = skillColl.get(req.params.skill_id);
    if (sc && sc.install_count > 0) skillColl.update(req.params.skill_id, { install_count: sc.install_count - 1 });

    store.log('info', 'agents', `agent ${agent.name} 卸载技能 ${req.params.skill_id}`);
    res.json({ ...publicAgent(updated), presence: presenceOf(updated, store.coll('tasks'), util.now()) });
  });

  return router;
}
