// 测试 chat 进度展示：
// 1) 使用独立数据目录启动临时 ai-bridge 实例
// 2) 登录并创建 agent
// 3) 发送一条 chat 消息
// 4) agent 领取任务并上报 progress
// 5) 用 Playwright 截图验证前端气泡展示"已用时"和 progress 文本

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4577;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = '/tmp/ai-bridge-test-chat-progress';
const USER = 'admin';
const PASS = 'admin123';
const SESSION = 'test-progress';

function log(kind, ...args) {
  const c = { ok: '\x1b[32m', err: '\x1b[31m', info: '\x1b[36m', reset: '\x1b[0m' };
  const p = kind === 'ok' ? `${c.ok}✓` : kind === 'err' ? `${c.err}✗` : `${c.info}ℹ`;
  console.log(p, ...args, c.reset);
}

async function http(method, path, { token, body, asAgent } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (asAgent) {
    headers.agent_id = asAgent.agent_id;
    headers.token = asAgent.token;
  }
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`);
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
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const proc = spawn('node', ['src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), AIBRIDGE_DATA_DIR: DATA_DIR, ILINK_MOCK: '1' },
    stdio: 'pipe',
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  await waitForServer();
  log('ok', `临时服务已启动: ${BASE}`);
  return proc;
}

async function login() {
  const r = await http('POST', '/api/auth/login', { body: { username: USER, password: PASS } });
  if (!r.token) throw new Error('login failed: no token');
  log('ok', '登录成功');
  return r.token;
}

async function createAgent(token) {
  const r = await http('POST', '/api/agents', { token, body: { name: 'progress-test-agent', capabilities: ['chat'] } });
  log('ok', '创建测试 agent', r.agent_id);
  return { agent_id: r.agent_id, token: r.token };
}

async function sendChat(token, content) {
  const r = await http('POST', '/api/chat', { token, body: { session_id: SESSION, content } });
  log('ok', `发送消息: "${content}" → task ${r.task.id}`);
  return r.task;
}

async function main() {
  const proc = await startServer();
  let browser;
  try {
    const token = await login();
    const agent = await createAgent(token);

    await http('POST', '/api/sessions', { token, body: { id: SESSION, name: '进度测试会话' } });
    const task = await sendChat(token, '帮我查一下磁盘空间');

    await http('GET', `/api/task/poll?agent_id=${agent.agent_id}&token=${agent.token}&timeout=5`, { asAgent: agent });
    log('ok', 'agent 已领取任务');

    await http('POST', '/api/task/progress', {
      asAgent: agent,
      body: { task_id: task.id, progress: '正在执行 df -h，查看磁盘使用情况...' },
    });
    log('ok', '已上报 progress');

    browser = await chromium.launch({
      headless: true,
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(`${BASE}/login.html`);
    await page.fill('input[type="text"]', USER);
    await page.fill('input[type="password"]', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/#\/overview/, { timeout: 5000 });

    await page.goto(`${BASE}/#/chat`);
    await page.waitForTimeout(800);
    // 点击会话项本身（不是操作按钮）进入进度测试会话
    await page.click(`.session-item:has-text("进度测试会话") .s-name`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: '/tmp/chat-progress.png', fullPage: true });

    const bubble = page.locator('.msg-row.sys .msg-bubble, .msg-row.agent .msg-bubble').last();
    await bubble.waitFor({ timeout: 5000 });
    const bubbleText = await bubble.textContent();
    log('info', '最后一条回复气泡文本:', bubbleText?.replace(/\s+/g, ' ').trim());

    if (bubbleText && (bubbleText.includes('已接单') || bubbleText.includes('执行中') || bubbleText.includes('df -h'))) {
      log('ok', '进度气泡展示正常');
    } else {
      log('err', '进度气泡未展示预期文本');
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
