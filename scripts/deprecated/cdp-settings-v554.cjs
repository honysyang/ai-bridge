// E2E: 截图设置面板 v5.5.4 分栏布局 + 用户管理 + 自定义模型
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9232;
const URL = 'http://127.0.0.1:4567/';
const OUT_DIR = '/tmp/settings-v554';

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1600,1200',
    `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stdout.on('data', d => console.log('[chromium out]', d.toString().slice(0, 200)));
  chrome.stderr.on('data', d => console.log('[chromium err]', d.toString().slice(0, 200)));

  let ws;
  try {
    for (let i = 0; i < 50; i++) {
      try { await getJSON('/json/version'); break; }
      catch { await new Promise(r => setTimeout(r, 200)); }
    }
    const tabs = await getJSON('/json');
    ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    function send(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    await new Promise((r) => ws.on('open', r));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');

    await send('Page.navigate', { url: URL });
    await new Promise((r) => setTimeout(r, 10000));

    // 切到设置 tab
    const r1 = await send('Runtime.evaluate', {
      expression: `(async function() {
        for (let i = 0; i < 30; i++) {
          if (window.Main && window.Main.switchTab) break;
          await new Promise(r => setTimeout(r, 200));
        }
        window.Main.switchTab('settings');
        await new Promise(r => setTimeout(r, 2000));
        const nav = document.querySelectorAll('.settings-nav-item');
        const title = document.querySelector('.settings-main-title')?.textContent;
        return JSON.stringify({
          navCount: nav.length,
          navSections: Array.from(nav).map(b => b.dataset.section),
          title
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Settings nav:', r1.result.value);

    // 截 7 个子区段（含用户管理，本地访问时无需登录，admin 导航会显示）
    const sections = ['models', 'system', 'logs', 'wechat', 'users', 'security', 'about'];
    for (const sec of sections) {
      const r = await send('Runtime.evaluate', {
        expression: `(async function() {
          const btn = document.querySelector('.settings-nav-item[data-section="${sec}"]');
          if (!btn) return JSON.stringify({ section: '${sec}', skipped: true });
          btn.click();
          await new Promise(r => setTimeout(r, 1500));
          const section = document.querySelector('#settings-section-${sec}');
          const title = document.querySelector('.settings-main-title')?.textContent;
          return JSON.stringify({
            section: '${sec}',
            title,
            hidden: section?.hidden || false,
            childCount: section ? section.children.length : 0
          });
        })()`,
        returnByValue: true,
        awaitPromise: true
      });
      console.log(`Section ${sec}:`, r.result.value);
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const out = `${OUT_DIR}/section-${sec}.png`;
      fs.writeFileSync(out, Buffer.from(result.data, 'base64'));
      console.log(`  saved: ${out} (${fs.statSync(out).size} bytes)`);
    }

    // 搜索过滤测试
    const rSearch = await send('Runtime.evaluate', {
      expression: `(async function() {
        const input = document.querySelector('#settings-search');
        input.value = '日志';
        input.dispatchEvent(new Event('input'));
        await new Promise(r => setTimeout(r, 300));
        const visible = Array.from(document.querySelectorAll('.settings-nav-item')).filter(b => b.style.display !== 'none').map(b => b.dataset.section);
        return JSON.stringify({ visible });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Search filter:', rSearch.result.value);

    // 切到概览页截图
    const rOverview = await send('Runtime.evaluate', {
      expression: `(async function() {
        window.Main.switchTab('overview');
        await new Promise(r => setTimeout(r, 3000));
        const toolbar = document.querySelector('.overview-toolbar');
        const container = document.querySelector('.overview-container');
        return JSON.stringify({
          hasToolbar: !!toolbar,
          hasContainer: !!container,
          statCount: document.querySelectorAll('.stat-card').length,
          chartCount: document.querySelectorAll('.chart-card').length
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Overview:', rOverview.result.value);
    const overviewResult = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const overviewOut = `${OUT_DIR}/section-overview.png`;
    fs.writeFileSync(overviewOut, Buffer.from(overviewResult.data, 'base64'));
    console.log(`  saved: ${overviewOut} (${fs.statSync(overviewOut).size} bytes)`);
  } finally {
    try { ws && ws.close(); } catch {}
    try { process.kill(chrome.pid, 'SIGKILL'); } catch {}
    setTimeout(() => process.exit(0), 200);
  }
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
