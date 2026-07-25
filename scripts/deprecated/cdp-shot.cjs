// 用 chromium 远程调试 + CDP，等数据加载完再截图
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9222;
const URL = process.argv[2] || 'http://127.0.0.1:4567/?_=cdp#tab/settings';
const OUT = process.argv[3] || '/tmp/screenshot.png';
const WAIT_MS = parseInt(process.argv[4] || '6000', 10);

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

    // 收集 console 消息
    const logs = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push(msg.params.type + ': ' + msg.params.args.map(a => a.value || a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        logs.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails));
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });

    await send('Page.navigate', { url: URL });

    // 等待 page load + 自定义时间（让 fetch 完成）
    await new Promise((r) => setTimeout(r, WAIT_MS));

    console.log('console logs:');
    logs.slice(0, 30).forEach(l => console.log('  ', l));

    // 直接 fetch 测试
    const fetchTest = await send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const r = await fetch('/api/models');
          const text = await r.text();
          return 'status=' + r.status + ' len=' + text.length + ' head=' + text.slice(0, 100);
        } catch (e) {
          return 'error: ' + e.message;
        }
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('fetch test:', fetchTest.result.value);

    // 验证数据已渲染（DeepSeek 是否在下拉里）
    const check = await send('Runtime.evaluate', {
      expression: `(function() {
        const sel = document.getElementById('setting-model-provider');
        const opts = sel ? Array.from(sel.options).map(o => o.value) : [];
        const pl = document.getElementById('provider-list');
        const providerCards = pl ? pl.querySelectorAll('.provider-card').length : 0;
        const activeSection = document.querySelector('.settings-section:not([hidden])')?.id || 'none';
        const hasSettings = typeof window.Settings !== 'undefined';
        const hasInit = hasSettings && typeof window.initSettings;
        return JSON.stringify({ providerOptions: opts, providerCards, activeSection, hasSettings, hasInit, currentTab: window.state && window.state.currentTab });
      })()`,
      returnByValue: true
    });
    console.log('DOM check:', check.result.value);

    // 截图
    const result = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(result.data, 'base64'));
    console.log('saved:', OUT, fs.statSync(OUT).size, 'bytes');
  } finally {
    try { ws && ws.close(); } catch {}
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
    setTimeout(() => process.exit(0), 200);
  }
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
