// 测试对话气泡 markdown 渲染 + evidence 折叠展示
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4577;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = '/tmp/ai-bridge-test-chat-md';
const USER = 'admin';
const PASS = 'admin123';
const SESSION = 'test-md-evidence';

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
  const r = await http('POST', '/api/agents', { token, body: { name: 'md-evidence-agent', capabilities: ['chat'] } });
  log('ok', '创建测试 agent', r.agent_id);
  return { agent_id: r.agent_id, token: r.token };
}

async function main() {
  const proc = await startServer();
  let browser;
  try {
    const token = await login();
    const agent = await createAgent(token);

    await http('POST', '/api/sessions', { token, body: { id: SESSION, name: 'Markdown + Evidence 测试' } });
    const task = await http('POST', '/api/chat', { token, body: { session_id: SESSION, content: '帮我写个快速排序' } });
    log('ok', '发送 chat 消息', task.task.id);

    // 直接通过内部接口完成该任务（带 evidence）
    const result = {
      summary: '快速排序 Python 实现如下：\n\n```python\ndef quick_sort(arr):\n    if len(arr) <= 1: return arr\n    pivot = arr[len(arr)//2]\n    left = [x for x in arr if x < pivot]\n    mid = [x for x in arr if x == pivot]\n    right = [x for x in arr if x > pivot]\n    return quick_sort(left) + mid + quick_sort(right)\n```\n\n核心思路：\n- 选基准 pivot\n- 分成小/等/大三部分\n- 递归排序后合并',
      evidence: {
        executed_commands: ['pip install pytest', 'python -m pytest test_sort.py -v'],
        read_files: ['src/algo/sort.py', 'tests/test_sort.py'],
        searches: ['python quick sort implementation'],
        tool_calls: [{ tool: 'bridge_create_task', params: { type: 'execute_command', content: 'run tests' } }],
        thinking: '用户需要快速排序示例，选择 Python 可读性强。先用 pytest 验证，再返回代码。',
      },
    };
    await http('POST', '/api/task/complete', {
      asAgent: agent,
      body: { task_id: task.task.id, status: 'completed', result },
    });
    log('ok', '已完成任务并提交 evidence');

    browser = await chromium.launch({
      headless: true,
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console.error]', msg.text()); });
    page.on('pageerror', (err) => console.log('  [pageerror]', err.message));

    // 直接注入 token 登录，避免表单交互依赖
    await page.goto(BASE + '/');
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('ab_token', token);
      localStorage.setItem('ab_user', JSON.stringify(user));
    }, { token, user: { username: USER, roles: ['admin'] } });
    await page.goto(BASE + '/#/chat');
    await page.waitForSelector('#sidebar', { timeout: 8000 });
    await page.goto(BASE + '/#/chat');
    await page.waitForSelector('.session-item', { timeout: 8000 });
    await page.click('.session-item:has-text("Markdown + Evidence 测试") .s-name');
    await page.waitForTimeout(800);
    await page.screenshot({ path: '/tmp/chat-md-evidence.png', fullPage: true });

    // 验证代码块存在
    const hasCodeBlock = await page.locator('.msg-bubble .md-code-block').count() > 0;
    if (hasCodeBlock) log('ok', '代码块已渲染');
    else { log('err', '代码块未渲染'); process.exitCode = 1; }

    // 验证列表存在
    const hasList = await page.locator('.msg-bubble .md-list').count() > 0;
    if (hasList) log('ok', '列表已渲染');
    else { log('err', '列表未渲染'); process.exitCode = 1; }

    // 验证 evidence 折叠条存在
    const ev = page.locator('.evidence-summary').first();
    await ev.waitFor({ timeout: 5000 });
    const evText = await ev.textContent();
    if (evText?.includes('查看执行过程') && evText?.includes('2 条命令')) {
      log('ok', 'evidence 折叠条展示正确：', evText.trim());
    } else {
      log('err', 'evidence 折叠条文本不符合预期：', evText?.trim());
      process.exitCode = 1;
    }

    // 点击展开 evidence 并截图
    await ev.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/chat-evidence-open.png', fullPage: true });
    log('ok', '已展开 evidence 并截图 /tmp/chat-evidence-open.png');
  } finally {
    if (browser) await browser.close();
    proc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
