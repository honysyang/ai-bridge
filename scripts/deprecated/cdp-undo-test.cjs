// v5.4.3: 测试 undo 流程（撤回后渲染 undo_history + restore 按钮）
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9226;
const URL = 'http://127.0.0.1:4567/';
const OUT = '/tmp/undo-history.png';
const TASK_ID = 'task-1784859310781-59';

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
  // 先通过 API 撤回 task
  const undoResp = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 4567, path: `/api/tasks/${TASK_ID}/undo`, method: 'POST'
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end();
  });
  console.log('undo api:', undoResp.status, undoResp.data.slice(0, 200));

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
    await new Promise((r) => setTimeout(r, 8000));

    const r = await send('Runtime.evaluate', {
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
        return JSON.stringify({
          hasUndoHistory: !!document.querySelector('.undo-history'),
          undoHistoryTitle: (document.querySelector('.undo-history-title') || {}).textContent,
          restoreBtnCount: document.querySelectorAll('.undo-restore-btn').length
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('UI check:', r.result.value);

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
