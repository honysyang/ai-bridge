// 测试 chat 上下文构造：
// 1) 使用独立数据目录启动一个临时 ai-bridge 实例（端口 4577）
// 2) 登录获取 token
// 3) 在 session_id=test-context 中发送 "1+1 等于几"
// 4) 验证该任务的 data.extra.context 只包含当前用户消息（没有 assistant 记录）
// 5) 模拟 agent 完成该任务
// 6) 发送第二条消息 "把刚才的结果再细化一下"
// 7) 验证第二条任务的 data.extra.context 包含前一轮 user + assistant 记录

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4577;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = '/tmp/ai-bridge-test-chat-context';
const USER = 'admin';
const PASS = 'admin123';
const SESSION = 'test-context';

const colors = {
  ok: '\x1b[32m',   // green
  err: '\x1b[31m',  // red
  info: '\x1b[36m', // cyan
  reset: '\x1b[0m',
};

function log(kind, ...args) {
  const prefix = kind === 'ok' ? `${colors.ok}✓` : kind === 'err' ? `${colors.err}✗` : `${colors.info}ℹ`;
  console.log(prefix, ...args, colors.reset);
}

async function http(method, path, { token, body, asAgent } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (asAgent) {
    headers.agent_id = asAgent.agent_id;
    headers.token = asAgent.token;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status}: ${text}`);
  }
  return data;
}

async function waitForServer(maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start in time');
}

async function startServer() {
  // 清理旧数据，保证测试独立
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const proc = spawn('node', ['src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), AIBRIDGE_DATA_DIR: DATA_DIR },
    stdio: 'pipe',
  });
  let serverLogs = '';
  proc.stdout.on('data', (d) => { serverLogs += d.toString(); });
  proc.stderr.on('data', (d) => { serverLogs += d.toString(); });
  await waitForServer();
  log('ok', `临时服务已启动: ${BASE}`);
  return proc;
}

async function login() {
  const r = await http('POST', '/api/auth/login', { body: { username: USER, password: PASS } });
  if (!r.token) throw new Error('login failed: no token');
  log('ok', '登录成功', r.user?.username);
  return r.token;
}

async function createAgent(token) {
  const r = await http('POST', '/api/agents', {
    token,
    body: { name: 'context-test-agent', capabilities: ['chat'] },
  });
  log('ok', '创建测试 agent', r.agent_id);
  return { agent_id: r.agent_id, token: r.token };
}

async function sendChat(token, content) {
  const r = await http('POST', '/api/chat', {
    token,
    body: { session_id: SESSION, content },
  });
  log('ok', `发送消息: "${content}" → task ${r.task.id}`);
  return r.task;
}

async function completeTask(agent, taskId, summary) {
  await http('POST', '/api/task/complete', {
    asAgent: agent,
    body: {
      task_id: taskId,
      status: 'completed',
      result: { summary },
    },
  });
  log('ok', `完成 task ${taskId}: "${summary}"`);
}

async function getTask(token, taskId) {
  return http('GET', `/api/tasks/${taskId}`, { token });
}

function contextToString(ctx) {
  return JSON.stringify(ctx.map((m) => ({ role: m.role, content: m.content })));
}

async function main() {
  const proc = await startServer();
  try {
    const token = await login();
    const agent = await createAgent(token);

    // 1. 发送第一条消息
    const task1 = await sendChat(token, '1+1 等于几');
    const t1 = await getTask(token, task1.id);
    const ctx1 = t1.data?.extra?.context || [];
    log('info', '第一条任务 context:', contextToString(ctx1));

    // 验证：只有一条 user，且 content 是第一条消息，没有 assistant 记录
    const ownUser = ctx1.find((m) => m.role === 'user' && m.content === '1+1 等于几');
    if (!ownUser) throw new Error('第一条任务 context 缺少当前 user 消息');
    const hasAssistant = ctx1.some((m) => m.role === 'assistant');
    if (hasAssistant) throw new Error('第一条任务 context 不应包含 assistant 记录');
    log('ok', '第一条任务 context 仅包含当前用户消息');

    // 2. 模拟 agent 完成第一条
    await completeTask(agent, task1.id, '1+1 等于 2。');

    // 3. 发送第二条消息
    const task2 = await sendChat(token, '把刚才的结果再细化一下');
    const t2 = await getTask(token, task2.id);
    const ctx2 = t2.data?.extra?.context || [];
    log('info', '第二条任务 context:', contextToString(ctx2));

    // 验证：包含前一轮 user + assistant，以及当前 user
    const prevUser = ctx2.find((m) => m.role === 'user' && m.content === '1+1 等于几');
    const prevAssistant = ctx2.find((m) => m.role === 'assistant' && m.content === '1+1 等于 2。');
    const currentUser = ctx2.find((m) => m.role === 'user' && m.content === '把刚才的结果再细化一下');
    if (!prevUser) throw new Error('第二条任务 context 缺少前一轮 user 消息');
    if (!prevAssistant) throw new Error('第二条任务 context 缺少前一轮 assistant 消息');
    if (!currentUser) throw new Error('第二条任务 context 缺少当前 user 消息');

    // 验证顺序：user -> assistant -> user
    const expected = [
      { role: 'user', content: '1+1 等于几' },
      { role: 'assistant', content: '1+1 等于 2。' },
      { role: 'user', content: '把刚才的结果再细化一下' },
    ];
    for (let i = 0; i < expected.length; i++) {
      if (ctx2[i]?.role !== expected[i].role || ctx2[i]?.content !== expected[i].content) {
        throw new Error(`context[${i}] 顺序不匹配: 期望 ${JSON.stringify(expected[i])}, 实际 ${JSON.stringify(ctx2[i])}`);
      }
    }
    log('ok', '第二条任务 context 正确包含完整对话历史');

    console.log(`\n${colors.ok}=== 测试全部通过 ===${colors.reset}`);
  } finally {
    proc.kill('SIGTERM');
    // 可选：保留数据目录用于排查；成功时清理
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => {
  log('err', '测试失败:', e.message);
  console.error(e);
  process.exit(1);
});
