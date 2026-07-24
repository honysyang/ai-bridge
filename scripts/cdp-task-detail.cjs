// v5.4.3: 截图任务详情（含 undo / 补充对话 区域）
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9223;
const URL = process.argv[2] || 'http://127.0.0.1:4567/';
const OUT = process.argv[3] || '/tmp/task-detail.png';
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
    '--window-size=1600,1000',
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
    await send('Page.enable');
    await send('Runtime.enable');

    await send('Page.navigate', { url: URL });
    // 等待首次加载
    await new Promise((r) => setTimeout(r, WAIT_MS));

    // 切到 chat tab 并选中目标 task
    const sel = await send('Runtime.evaluate', {
      expression: `(async function() {
        try {
          // 等 core 加载完
          for (let i = 0; i < 30; i++) {
            if (window.Tasks && window.Sessions) break;
            await new Promise(r => setTimeout(r, 200));
          }
          // 切到 chat tab
          if (window.Main && window.Main.switchTab) window.Main.switchTab('chat');
          await new Promise(r => setTimeout(r, 600));
          // 加载会话列表
          if (window.Sessions && window.Sessions.loadSessions) await window.Sessions.loadSessions();
          await new Promise(r => setTimeout(r, 600));
          // 选中目标 task
          if (window.Tasks && window.Tasks.selectTask) window.Tasks.selectTask('${TASK_ID}');
          await new Promise(r => setTimeout(r, 1500));
          return JSON.stringify({
            currentTask: window.state && window.state.currentTaskId,
            detailBody: (document.getElementById('detail-body') || {}).innerHTML ? document.getElementById('detail-body').innerHTML.length : 0,
            hasUndoBtn: !!document.querySelector('[data-action="undo"]'),
            hasFollowupSection: !!document.querySelector('.followup-section'),
            hasFollowupInput: !!document.getElementById('followup-input-${TASK_ID}'),
            hasRestoreBtn: document.querySelectorAll('.undo-restore-btn').length
          });
        } catch (e) {
          return 'error: ' + e.message + ' ' + e.stack;
        }
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('DOM state:', sel.result.value);

    console.log('console logs (first 30):');
    logs.slice(0, 30).forEach(l => console.log('  ', l));

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
  console.error(e.stack);
  process.exit(1);
});
