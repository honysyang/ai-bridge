// 测试 chat 快捷指令：@指派 /prompt /workflow /kb /retry /reassign
// 1) 使用独立数据目录启动临时 ai-bridge 实例
// 2) 登录并创建 2 个 agent
// 3) 创建 prompt、workflow、kb item
// 4) 用 Playwright 在前端验证：
//    - @agentName 发送后 target_agent 正确
//    - 失败气泡带「重试」「改派」按钮
//    - 点击改派后任务 target_agent 改变
//
// 运行：node scripts/test-chat-commands.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4579;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = '/tmp/ai-bridge-test-chat-commands';
const USER = 'admin';
const PASS = 'admin123';
const SESSION = 'test-commands';

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

async function createAgent(token, name, capabilities = []) {
  const r = await http('POST', '/api/agents', { token, body: { name, capabilities } });
  log('ok', `创建 agent`, r.agent_id, name);
  return { agent_id: r.agent_id, token: r.token };
}

async function main() {
  const proc = await startServer();
  let browser;
  try {
    const token = await login();
    const agentA = await createAgent(token, 'Trae', ['chat']);
    const agentB = await createAgent(token, 'Claw', ['chat']);

    await http('POST', '/api/sessions', { token, body: { id: SESSION, name: '命令测试会话' } });

    // 准备 prompt、workflow、kb item
    await http('POST', '/api/prompts', {
      token,
      body: { name: '周报', category: '工作', content: '请写一份{{week}}周报，重点{{focus}}。' },
    });
    await http('POST', '/api/workflows', {
      token,
      body: {
        name: '合同审核',
        description: '快速合同审核',
        steps: [{ name: '初审', content: '审核合同风险点' }],
      },
    });
    await http('POST', '/api/kb/categories', { token, body: { name: '测试' } });
    const cat = (await http('GET', '/api/kb', { token })).categories[0];
    await http('POST', '/api/kb/items', {
      token,
      body: { category_id: cat.id, title: '海绵样本', content: '海绵样本是一种多孔材料，常用于吸水。' },
    });

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
    await page.waitForTimeout(600);
    await page.click(`.session-item:has-text("命令测试会话") .s-name`);
    await page.waitForTimeout(500);

    // 1) @Trae 帮我查磁盘
    await page.fill('#chatInput', '@Trae 帮我查磁盘');
    await page.click('#chatSend');
    await page.waitForTimeout(1000);

    const messages = await http('GET', `/api/chat/${SESSION}/messages`, { token });
    const task1 = messages.find((t) => t.data?.content === '帮我查磁盘');
    if (!task1) throw new Error('未找到 @Trae 发送的任务');
    if (task1.target_agent !== agentA.agent_id) {
      throw new Error(`target_agent 错误：期望 ${agentA.agent_id}，实际 ${task1.target_agent}`);
    }
    log('ok', '@Trae 指派成功，target_agent 正确');

    // 2) 让 agentA 领取并标记失败，验证失败气泡按钮
    await http('GET', `/api/task/poll?agent_id=${agentA.agent_id}&token=${agentA.token}&timeout=5`, { asAgent: agentA });

    await http('POST', '/api/task/complete', {
      asAgent: agentA,
      body: { task_id: task1.id, status: 'failed', result: { summary: '磁盘命令执行失败' } },
    });

    // 等待前端轮询刷新失败状态（pollTask 2s 一次，+ 渲染留余量）
    await page.waitForTimeout(4200);
    await page.screenshot({ path: '/tmp/chat-commands-failed.png', fullPage: true });

    const retryBtn = page.locator('.btn-retry').last();
    const reassignBtn = page.locator('.btn-reassign').last();
    await retryBtn.waitFor({ timeout: 5000 });
    await reassignBtn.waitFor({ timeout: 5000 });
    log('ok', '失败气泡包含「重试」「改派」按钮');

    // 3) 点击改派 -> 改派给 Claw
    await reassignBtn.click();
    await page.waitForTimeout(300);
    await page.selectOption('#reassignAgent', agentB.agent_id);
    await page.click('.modal-foot .btn-primary');
    await page.waitForTimeout(1000);

    const messages2 = await http('GET', `/api/chat/${SESSION}/messages`, { token });
    const reassigned = messages2.find((t) => t.id === task1.id);
    if (reassigned.target_agent !== agentB.agent_id) {
      throw new Error(`改派后 target_agent 错误：期望 ${agentB.agent_id}，实际 ${reassigned.target_agent}`);
    }
    if (reassigned.status !== 'pending') {
      throw new Error(`改派后状态错误：期望 pending，实际 ${reassigned.status}`);
    }
    log('ok', '改派后任务 target_agent 已改为 Claw 且状态为 pending');

    // 4) 验证快捷指令 /kb /workflow /prompt 不抛错且产生消息
    await page.fill('#chatInput', '/kb 什么是海绵样本');
    await page.click('#chatSend');
    await page.waitForTimeout(800);

    await page.fill('#chatInput', '/workflow 合同审核');
    await page.click('#chatSend');
    await page.waitForTimeout(800);

    await page.fill('#chatInput', '/prompt 周报');
    await page.click('#chatSend');
    await page.waitForTimeout(300);
    await page.fill('.prompt-var-input[data-var="week"]', '本周');
    await page.fill('.prompt-var-input[data-var="focus"]', '性能优化');
    await page.click('.modal-foot .btn-primary');
    await page.waitForTimeout(800);

    await page.screenshot({ path: '/tmp/chat-commands-all.png', fullPage: true });
    log('ok', '快捷指令 /kb /workflow /prompt 已执行');

    const finalMessages = await http('GET', `/api/chat/${SESSION}/messages`, { token });
    const hasKb = finalMessages.some((t) => t.source === 'kb');
    const hasSystem = finalMessages.some((t) => t.source === 'system' && t.data?.content?.includes('已触发工作流'));
    const hasPrompt = finalMessages.some((t) => t.data?.extra?.prompt_name === '周报');
    if (!hasKb) throw new Error('未找到 /kb 产生的知识库消息');
    if (!hasSystem) throw new Error('未找到 /workflow 产生的系统消息');
    if (!hasPrompt) throw new Error('未找到 /prompt 产生的提示词任务');
    log('ok', '所有快捷指令均已生成对应会话消息');

    console.log('\x1b[32m=== 测试全部通过 ===\x1b[0m');
  } finally {
    if (browser) await browser.close();
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
