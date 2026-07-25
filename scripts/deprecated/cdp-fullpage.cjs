// v5.4.3: 截图任务详情（全页面 + 高亮撤回/补充区域）
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9224;
const URL = process.argv[2] || 'http://127.0.0.1:4567/';
const OUT = process.argv[3] || '/tmp/task-detail-full.png';
const TASK_ID = process.argv[4] || 'task-1784859310781-59';
const WAIT_MS = parseInt(process.argv[5] || '8000', 10);

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
    '--window-size=1600,1800',
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
    await new Promise((r) => setTimeout(r, WAIT_MS));

    // 切到 chat tab + 选 task
    await send('Runtime.evaluate', {
      expression: `(async function() {
        for (let i = 0; i < 30; i++) {
          if (window.Tasks && window.Sessions) break;
          await new Promise(r => setTimeout(r, 200));
        }
        if (window.Main && window.Main.switchTab) window.Main.switchTab('chat');
        await new Promise(r => setTimeout(r, 800));
        if (window.Sessions && window.Sessions.loadSessions) await window.Sessions.loadSessions();
        await new Promise(r => setTimeout(r, 800));
        if (window.Tasks && window.Tasks.selectTask) window.Tasks.selectTask('${TASK_ID}');
        await new Promise(r => setTimeout(r, 1500));
        // 滚动 detail-body 到顶
        const db = document.getElementById('detail-body');
        if (db) db.scrollTop = 0;
        await new Promise(r => setTimeout(r, 200));
        // 拿一些度量
        const undo = document.querySelector('[data-action="undo"]');
        const fuSec = document.querySelector('.followup-section');
        const undoRect = undo && undo.getBoundingClientRect();
        const fuRect = fuSec && fuSec.getBoundingClientRect();
        return JSON.stringify({
          undoBtn: !!undo, undoRect: undoRect ? {x:Math.round(undoRect.x),y:Math.round(undoRect.y),w:Math.round(undoRect.width),h:Math.round(undoRect.height)} : null,
          followup: !!fuSec, fuRect: fuRect ? {x:Math.round(fuRect.x),y:Math.round(fuRect.y),w:Math.round(fuRect.width),h:Math.round(fuRect.height)} : null
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    }).then(r => console.log('rects:', r.result.value));

    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
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
