// 截图概览页和设置页对比
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9232;
const URL = 'http://127.0.0.1:4567/';

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
  fs.mkdirSync('/tmp/style-compare', { recursive: true });
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

    // 切到概览
    await send('Runtime.evaluate', {
      expression: `(async function() {
        for (let i = 0; i < 30; i++) {
          if (window.Main && window.Main.switchTab) break;
          await new Promise(r => setTimeout(r, 200));
        }
        window.Main.switchTab('overview');
        await new Promise(r => setTimeout(r, 2000));
        return 'ok';
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    let r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/style-compare/overview-before.png', Buffer.from(r.data, 'base64'));
    console.log('overview saved');

    // 切到设置
    await send('Runtime.evaluate', {
      expression: `window.Main.switchTab('settings'); await new Promise(r => setTimeout(r, 2000))`,
      returnByValue: true,
      awaitPromise: true
    });
    r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/style-compare/settings-before.png', Buffer.from(r.data, 'base64'));
    console.log('settings saved');

    // 提取概览页的样式信息
    const r2 = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        panel: (function() {
          const el = document.getElementById('panel-overview');
          const cs = getComputedStyle(el);
          return {
            bg: cs.backgroundColor,
            padding: cs.padding,
            fontFamily: cs.fontFamily,
            color: cs.color
          };
        })(),
        heroTitle: (function() {
          const el = document.querySelector('.overview-title');
          const cs = getComputedStyle(el);
          return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color };
        })(),
        statCard: (function() {
          const el = document.querySelector('.stat-card');
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, border: cs.border };
        })(),
        chartCard: (function() {
          const el = document.querySelector('.chart-card');
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, border: cs.border };
        })(),
        quickCard: (function() {
          const el = document.querySelector('.quick-card');
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, border: cs.border };
        })()
      })`,
      returnByValue: true
    });
    console.log('OVERVIEW STYLES:', r2.result.value);

    // 提取设置页的样式
    await send('Runtime.evaluate', {
      expression: `window.Main.switchTab('settings'); await new Promise(r => setTimeout(r, 2000))`,
      returnByValue: true,
      awaitPromise: true
    });
    const r3 = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        settingsCard: (function() {
          const el = document.querySelector('.settings-card');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, border: cs.border };
        })(),
        settingsSubnav: (function() {
          const el = document.querySelector('.settings-subnav');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius, border: cs.border };
        })(),
        subnavBtn: (function() {
          const el = document.querySelector('.subnav-btn');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius, color: cs.color, fontSize: cs.fontSize };
        })()
      })`,
      returnByValue: true
    });
    console.log('SETTINGS STYLES:', r3.result.value);

    // 提取 chat tab 样式
    await send('Runtime.evaluate', {
      expression: `window.Main.switchTab('chat'); await new Promise(r => setTimeout(r, 1500))`,
      returnByValue: true,
      awaitPromise: true
    });
    const r4 = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        compose: (function() {
          const el = document.querySelector('.compose-area, #compose-input, [class*="compose"]');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius, border: cs.border };
        })(),
        taskCard: (function() {
          const el = document.querySelector('.task-card, [class*="task-card"]');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, padding: cs.padding, borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, border: cs.border };
        })()
      })`,
      returnByValue: true
    });
    console.log('CHAT STYLES:', r4.result.value);

  } finally {
    try { ws && ws.close(); } catch {}
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
    setTimeout(() => process.exit(0), 200);
  }
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
