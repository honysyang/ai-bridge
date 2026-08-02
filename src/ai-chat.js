import { callAI } from './ai.js';

/**
 * 会话上下文压缩。
 * 当某会话已完成任务数超过窗口（每新增 6 条触发一次），取最老的 6 条 + 旧 summary，
 * 调 AI 生成新 summary（200 字内、保留关键结论与实体）。
 * AI 不可用时降级为直接丢弃超出窗口的历史。
 */
const WINDOW = 6;
const MAX_SUMMARY_LEN = 200;

export async function compressSession(ctx, sessionId) {
  const { store, events, util } = ctx;
  const tasks = store.coll('tasks');
  const sessions = store.coll('sessions');
  const session = sessions.get(sessionId);
  if (!session) return;

  // 仅取 source=chat 或 from_chat 的已完成任务
  const chatTasks = tasks
    .all()
    .filter((t) => t.session_id === sessionId && (t.source === 'chat' || t.data?.from_chat === true) && t.status === 'completed')
    .sort((a, b) => a.created_at - b.created_at);

  const count = chatTasks.length;
  if (count <= WINDOW) return;

  const old = session.context_summary || '';
  const oldest = chatTasks.slice(0, WINDOW);
  const remaining = chatTasks.slice(WINDOW);
  const oldestText = oldest
    .map((t) => `用户：${String(t.data?.content || '').slice(0, 300)}\n助手：${String(t.result?.summary || '').slice(0, 500)}`)
    .join('\n\n');
  const remainingHint = remaining
    .map((t) => `用户：${String(t.data?.content || '').slice(0, 80)}`)
    .join('\n');

  const prompt = [
    '请把以下对话记录压缩为一段中文摘要，供后续对话作为背景参考。',
    `要求：不超过 ${MAX_SUMMARY_LEN} 字；保留关键结论、实体名词、用户偏好和待办事项；不要罗列细节。`,
    old ? `\n已有旧摘要（可合并）：\n${old}` : '',
    `\n需要压缩的最早 ${WINDOW} 轮对话：\n${oldestText}`,
    remainingHint ? `\n后续还有待压缩的 ${remaining.length} 轮（仅列标题）：\n${remainingHint}` : '',
  ].join('\n');

  const aiResp = await callAI(ctx, {
    purpose: 'compress',
    messages: [
      { role: 'system', content: '你是对话摘要助手，只输出摘要文本，不解释格式。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 300,
  });

  const summary = aiResp?.content?.trim();
  if (summary) {
    sessions.update(session.id, { context_summary: summary });
    store.log('info', 'chat', `会话 ${session.id} 已压缩上下文（${oldest.length} 轮 → 摘要）`);
    events.emit('session:changed', sessions.get(session.id));
  } else {
    // 降级：无 AI 时不保留摘要，也不报错；后续上下文窗口仍由 recent 控制
    store.log('info', 'chat', `会话 ${session.id} 触发压缩，但 AI 不可用，直接丢弃最早 ${WINDOW} 轮`);
  }
}

/** 为 chat 任务组装 extra.context：recent 最近 6 条 + summary */
export function buildChatContext(ctx, sessionId, currentContent) {
  const tasks = ctx.store.coll('tasks');
  const session = ctx.store.coll('sessions').get(sessionId);
  const recent = tasks
    .all()
    .filter((t) => t.session_id === sessionId && (t.source === 'chat' || t.data?.from_chat === true) && t.status === 'completed')
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-WINDOW)
    .flatMap((t) => {
      const pair = [];
      const userContent = String(t.data?.content || '').trim();
      if (userContent) pair.push({ role: 'user', content: userContent, at: t.created_at });
      const agentContent = String(t.result?.summary || '').trim().slice(0, 500);
      if (agentContent) pair.push({ role: 'agent', content: agentContent, at: t.completed_at || t.created_at });
      return pair;
    })
    .filter((m) => String(m.content).trim());

  return {
    summary: session?.context_summary || null,
    recent: [...recent, { role: 'user', content: currentContent, at: ctx.util.now() }],
  };
}

/** 智能路由：根据任务内容和可用 agent 选择目标 agent 或 capability */
export async function routeTask(ctx, content) {
  const { store, util } = ctx;
  const now = util.now();
  const processingAgentIds = new Set(
    store.coll('tasks').all().filter((t) => t.status === 'processing' && t.assigned_to).map((t) => t.assigned_to)
  );
  const allAgents = store.coll('agents').all().filter((a) => a.review_status === 'active');
  const availableAgents = allAgents.filter((a) => {
    if (a.connection_type === 'mcp') {
      const last = Math.max(a.last_heartbeat_at || 0, a.mcp_session_at || 0);
      if (now - last > 60) return false;
    }
    if (processingAgentIds.has(a.id)) return false;
    return true;
  });

  if (!availableAgents.length) {
    return { by: 'fallback', reason: '当前没有可用智能体' };
  }

  const agentDesc = availableAgents.map((a) => ({
    id: a.id,
    name: a.name,
    capabilities: a.capabilities || [],
    connection_type: a.connection_type || 'unknown',
    presence: processingAgentIds.has(a.id) ? 'busy' : 'online',
  }));

  const prompt = [
    '请为下面用户请求，从可用智能体中选择最合适的一位，或推荐一个 capability 标签。',
    '返回 JSON：{"target_agent": "智能体名称或 null", "required_capability": "能力标签或 null", "reason": "一句话理由"}',
    '规则：如果某 agent 名称直接匹配用户的 @ 名称，优先选它；否则根据内容语义与 capabilities 匹配；若都不确定，都返回 null。',
    `\n可用智能体：\n${JSON.stringify(agentDesc, null, 2)}`,
    `\n用户请求：${content}`,
  ].join('\n');

  const aiResp = await callAI(ctx, {
    purpose: 'route',
    messages: [
      { role: 'system', content: '你是智能调度助手，只输出 JSON，不解释。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 300,
  });

  let parsed = null;
  if (aiResp?.content) {
    try {
      parsed = JSON.parse(aiResp.content.replace(/^```json\s*|\s*```$/g, ''));
    } catch { /* 忽略解析失败 */ }
  }

  if (!parsed) return { by: 'fallback', reason: 'AI 路由未返回有效 JSON' };

  // 校验：target_agent 必须存在且可用
  let targetId = null;
  if (parsed.target_agent) {
    const byName = availableAgents.find((a) => a.name === parsed.target_agent || a.id === parsed.target_agent);
    if (byName) targetId = byName.id;
  }

  if (targetId) {
    return {
      by: 'ai',
      reason: parsed.reason || 'AI 自动派单',
      target_agent: targetId,
    };
  }
  if (parsed.required_capability) {
    return {
      by: 'ai',
      reason: parsed.reason || 'AI 推荐能力标签',
      required_capability: parsed.required_capability,
    };
  }
  return { by: 'fallback', reason: parsed.reason || 'AI 未匹配到合适智能体' };
}

/** 周报润色：基于统计数据生成本周洞察段落 */
export async function generateWeeklyInsight(ctx, stats) {
  const prompt = [
    '请根据以下 ai-bridge 平台本周统计数据，生成一段不超过 300 字的中文“本周洞察”。',
    '要求：直接输出洞察文本，不要标题、不要列表、不要 markdown。',
    `\n统计数据：\n${JSON.stringify(stats, null, 2)}`,
  ].join('\n');

  const aiResp = await callAI(ctx, {
    purpose: 'report',
    messages: [
      { role: 'system', content: '你是数据分析助手，只输出简洁的中文洞察段落。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 500,
  });

  return aiResp?.content?.trim() || '';
}
