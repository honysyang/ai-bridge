// 截 4 个区段：models / system / logs / about
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9222;
const SECTIONS = ['models', 'system', 'logs', 'about'];

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
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,900',
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

    await send('Page.navigate', { url: 'http://127.0.0.1:4567/?_=cdp#tab/settings' });
    await new Promise((r) => setTimeout(r, 6000));  // 等 settings 初始化

    for (const sec of SECTIONS) {
      // 点击子导航按钮
      await send('Runtime.evaluate', {
        expression: `document.querySelector('.subnav-btn[data-section="${sec}"]')?.click()`,
        returnByValue: true
      });
      await new Promise((r) => setTimeout(r, 2500));  // 等数据加载

      // DOM 验证
      const check = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          activeSection: document.querySelector('.settings-section:not([hidden])')?.id || 'none',
          hasCards: document.querySelectorAll('.settings-card:not([hidden])').length,
          visibleInputs: document.querySelectorAll('.settings-section:not([hidden]) input, .settings-section:not([hidden]) select, .settings-section:not([hidden]) textarea').length,
          bodyText: (document.querySelector('.settings-section:not([hidden])')?.innerText || '').slice(0, 200).replace(/\\n/g, ' | ')
        })`,
        returnByValue: true
      });
      console.log(`[${sec}]`, check.result.value);

      // 截图
      const result = await send('Page.captureScreenshot', { format: 'png' });
      const out = `/home/kali/ai-bridge/docs/screenshots/settings-${sec}.png`;
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
