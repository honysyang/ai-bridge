import express from 'express';
import { registerRateOk } from './agents.js';
import { pickPendingTask, claimTask, completeTask, createTask } from './tasks.js';

import { searchKb } from './kb.js';

/**
 * mcp.js —— POST /mcp JSON-RPC 2.0 stateless 端点（SPEC §4）
 * 挂载于 / 。initialize / tools/list 无需凭证；
 * tools/call 中除 bridge_register 外均需 Authorization: Bearer agt_... 且 agent active。
 */

const PROTOCOL_VERSION = '2024-11-05';

// tool 描述全部为静态常量
const TOOLS = [
  {
    name: 'bridge_register',
    description: '注册一个新智能体到 ai-bridge（无需凭证）。返回 agent_id 与仅本次明文返回的 token，注册后处于 pending_review，等待管理员审核。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '智能体名称（必填）' },
        capabilities: { type: 'array', items: { type: 'string' }, description: '能力标签列表，如 ["shell","search"]' },
        host: { type: 'string', description: '所在主机标识' },
      },
      required: ['name'],
    },
  },
  {
    name: 'bridge_heartbeat',
    description: '上报心跳，刷新在线状态。返回当前 review_status 与服务器时间。建议每 5 秒调用一次。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_poll_task',
    description: '领取一个待处理任务（短轮询，立即返回，不挂起）。按 target_agent > required_capability > 通用 的优先级匹配；无任务时 task 为 null。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout: { type: 'number', description: '兼容参数，MCP 短轮询忽略' },
      },
    },
  },
  {
    name: 'bridge_complete_task',
    description: '汇报任务完成或失败。仅限领取该任务的智能体调用。完成后任务带 result，agent 统计累计。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID（必填）' },
        status: { type: 'string', enum: ['completed', 'failed'], description: '完成状态（必填）' },
        summary: { type: 'string', description: '结果摘要（必填）' },
        evidence: {
          type: 'object',
          description: '执行证据（可选）：{executed_commands:[], read_files:[], searches:[], tool_calls:[], thinking}',
        },
      },
      required: ['task_id', 'status', 'summary'],
    },
  },
  {
    name: 'bridge_create_task',
    description: '创建一个委派任务（source=delegation），可指定 target_agent 或 required_capability 定向派发。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '任务内容（必填）' },
        target_agent: { type: 'string', description: '指定执行的 agent ID' },
        required_capability: { type: 'string', description: '所需能力标签' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: '优先级，默认 normal' },
      },
      required: ['content'],
    },
  },
  {
    name: 'bridge_task_status',
    description: '查询任务当前状态与结果（result.summary / result.evidence）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID（必填）' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'bridge_kb_search',
    description: '检索知识库条目。按标题、内容、标签做关键词匹配，返回最相关的条目摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（必填）' },
        limit: { type: 'number', description: '返回数量上限（默认 5，最大 20）' },
      },
      required: ['query'],
    },
  },
];

export default function (ctx) {
  const { store, auth, util } = ctx;
  const router = express.Router();

  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const toolResult = (id, payload) => reply(id, { content: [{ type: 'text', text: JSON.stringify(payload) }] });

  /** 从 Authorization: Bearer agt_... 找 agent（扫描 + verifySecret） */
  function agentFromBearer(req) {
    const m = /^Bearer\s+(agt_[0-9a-f]+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    for (const a of store.coll('agents').all()) {
      if (a.token_hash && auth.verifySecret(m[1], a.token_hash)) return a;
    }
    return null;
  }

  // ---- tool 实现 ----
  function callRegister(args) {
    const { name, capabilities = [], host = '' } = args || {};
    if (!name || typeof name !== 'string') {
      const e = new Error('name required');
      e.code = -32602;
      throw e;
    }
    const token = auth.agentToken();
    const agent = {
      id: util.uid('agent'),
      name: String(name).slice(0, 100),
      review_status: 'pending_review',
      connection_type: 'mcp',
      capabilities: Array.isArray(capabilities) ? capabilities.map(String) : [],
      host: String(host || ''),
      skill_version: '',
      token_hash: auth.hashSecret(token),
      created_at: util.now(),
      last_heartbeat_at: null,
      mcp_session_at: null,
      stats: { total: 0, success: 0 },
    };
    store.coll('agents').insert(agent);
    store.log('info', 'mcp', `MCP agent 注册：${agent.name} (${agent.id})，等待审核`);
    return { agent_id: agent.id, token, review_status: agent.review_status };
  }

  function callHeartbeat(agent) {
    const updated = store.coll('agents').update(agent.id, { last_heartbeat_at: util.now() });
    return { ok: true, review_status: updated.review_status, server_time: util.now() };
  }

  function callPollTask(agent) {
    // MCP 短轮询：立即查一次，不挂起
    const task = pickPendingTask(store.coll('tasks'), agent);
    if (!task) return { task: null };
    return { task: claimTask(ctx, task, agent) };
  }

  function callCompleteTask(agent, args) {
    const { task_id, status, summary, evidence } = args || {};
    if (!task_id || !['completed', 'failed'].includes(status) || typeof summary !== 'string') {
      const e = new Error('task_id, status(completed|failed), summary required');
      e.code = -32602;
      throw e;
    }
    const task = store.coll('tasks').get(task_id);
    if (!task) {
      const e = new Error('task not found');
      e.code = -32000;
      throw e;
    }
    if (task.assigned_to !== agent.id) {
      const e = new Error('task not assigned to this agent');
      e.code = -32001;
      throw e;
    }
    const updated = completeTask(ctx, task, agent, status, { summary, ...(evidence ? { evidence } : {}) });
    return { ok: true, task: updated };
  }

  function callCreateTask(agent, args) {
    const { content, target_agent, required_capability, priority } = args || {};
    if (!content || typeof content !== 'string') {
      const e = new Error('content required');
      e.code = -32602;
      throw e;
    }
    if (target_agent && !store.coll('agents').get(target_agent)) {
      const e = new Error('target_agent not found');
      e.code = -32000;
      throw e;
    }
    const task = createTask(ctx, {
      type: 'execute_command',
      priority,
      source: 'delegation',
      data: { content },
      target_agent,
      required_capability,
    });
    return { task };
  }

  function callTaskStatus(args) {
    const { task_id } = args || {};
    if (!task_id) {
      const e = new Error('task_id required');
      e.code = -32602;
      throw e;
    }
    const task = store.coll('tasks').get(task_id);
    if (!task) {
      const e = new Error('task not found');
      e.code = -32000;
      throw e;
    }
    return { task };
  }

  function callKbSearch(args) {
    const { query, limit = 5 } = args || {};
    if (!query || typeof query !== 'string') {
      const e = new Error('query required');
      e.code = -32602;
      throw e;
    }
    return searchKb(ctx, query, Math.min(Math.max(Number(limit) || 5, 1), 20));
  }

  router.post('/mcp', (req, res) => {
    const { jsonrpc, id, method, params } = req.body || {};
    // JSON-RPC notification（无 id）：不响应 body
    if (id === undefined || id === null) {
      return res.status(202).end();
    }
    if (jsonrpc !== '2.0' || typeof method !== 'string') {
      return res.json(replyError(id, -32600, 'Invalid Request'));
    }

    switch (method) {
      case 'initialize':
        return res.json(reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'ai-bridge', version: '7.0.0' },
        }));

      case 'ping':
        return res.json(reply(id, {}));

      case 'tools/list':
        return res.json(reply(id, { tools: TOOLS }));

      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        if (typeof name !== 'string') {
          return res.json(replyError(id, -32602, 'params.name required'));
        }
        try {
          // bridge_register 无需凭证（限流同 REST register）
          if (name === 'bridge_register') {
            if (!registerRateOk(req.ip)) {
              return res.json(replyError(id, -32001, 'rate limited'));
            }
            return res.json(toolResult(id, callRegister(args)));
          }
          // 其余 tool 需要 Bearer agt_... 且 agent active
          const agent = agentFromBearer(req);
          if (!agent) {
            return res.json(replyError(id, -32001, 'unauthorized: Bearer agt_... required'));
          }
          if (agent.review_status !== 'active') {
            return res.json(replyError(id, -32001, `agent not active: ${agent.review_status}`));
          }
          // 每次调用更新 mcp_session_at
          store.coll('agents').update(agent.id, { mcp_session_at: util.now() });
          switch (name) {
            case 'bridge_heartbeat':
              return res.json(toolResult(id, callHeartbeat(agent)));
            case 'bridge_poll_task':
              return res.json(toolResult(id, callPollTask(agent)));
            case 'bridge_complete_task':
              return res.json(toolResult(id, callCompleteTask(agent, args)));
            case 'bridge_create_task':
              return res.json(toolResult(id, callCreateTask(agent, args)));
            case 'bridge_task_status':
              return res.json(toolResult(id, callTaskStatus(args)));
            case 'bridge_kb_search':
              return res.json(toolResult(id, callKbSearch(args)));
            default:
              return res.json(replyError(id, -32602, `unknown tool: ${name}`));
          }
        } catch (e) {
          return res.json(replyError(id, e.code || -32000, e.message));
        }
      }

      default:
        return res.json(replyError(id, -32601, `Method not found: ${method}`));
    }
  });

  return router;
}
