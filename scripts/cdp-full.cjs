// 截全页（fullPage）+ 设置/概览两个 tab
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9223;
const URL = process.argv[2] || 'http://127.0.0.1:4567/?_=full#tab/overview';
const OUT = process.argv[3] || '/tmp/full.png';
const WAIT_MS = parseInt(process.argv[4] || '10000', 10);

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
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await send('Page.navigate', { url: URL });
    await new Promise((r) => setTimeout(r, WAIT_MS));
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(OUT, Buffer.from(result.data, 'base64'));
    console.log('saved:', OUT, fs.statSync(OUT).size, 'bytes');
  } finally {
    try { ws && ws.close(); } catch {}
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
    setTimeout(() => process.exit(0), 200);
  }
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
