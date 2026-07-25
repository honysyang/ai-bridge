// E2E: 截图设置面板 4 个子区段
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9231;
const URL = 'http://127.0.0.1:4567/';
const OUT_DIR = '/tmp/settings-v530';

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
  ], { stdio: 'ignore', detached: true });

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
        const subnav = document.querySelectorAll('.subnav-btn');
        return JSON.stringify({
          subnavCount: subnav.length,
          subnavSections: Array.from(subnav).map(b => b.dataset.section),
          activeSection: document.querySelector('.subnav-btn.active')?.dataset.section
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Settings subnav:', r1.result.value);

    // 截 4 个子区段
    const sections = ['models', 'system', 'logs', 'about'];
    for (const sec of sections) {
      const r = await send('Runtime.evaluate', {
        expression: `(async function() {
          const btn = document.querySelector('.subnav-btn[data-section="${sec}"]');
          if (!btn) return 'no button';
          btn.click();
          await new Promise(r => setTimeout(r, 1500));
          // 统计渲染元素
          const sec = document.querySelector('#settings-section-${sec}');
          return JSON.stringify({
            section: '${sec}',
            visible: sec && sec.style.display !== 'none',
            childCount: sec ? sec.children.length : 0
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
  } finally {
    try { ws && ws.close(); } catch {}
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
    setTimeout(() => process.exit(0), 200);
  }
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
