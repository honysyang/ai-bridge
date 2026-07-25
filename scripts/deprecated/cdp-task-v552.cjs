// v5.5.2: 截图任务详情（含 KB RAG 检索结果展示）
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9223;
const URL = process.argv[2] || 'http://127.0.0.1:4567/';
const OUT = process.argv[3] || '/tmp/task-detail-v552.png';
const TASK_ID = process.argv[4] || '';
const WAIT_MS = parseInt(process.argv[5] || '9000', 10);

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
  // 如果没有传入 TASK_ID，从最新任务里挑一个带 kb_retrieval 的
  let taskId = TASK_ID;
  if (!taskId) {
    try {
      const resp = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:4567/api/tasks?limit=20', (r) => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
        }).on('error', rej);
      });
      const json = JSON.parse(resp);
      const tasks = (json.data || []).filter(t => t.context && t.context.kb_retrieval);
      if (tasks.length > 0) taskId = tasks[0].id;
      else if (json.data && json.data.length > 0) taskId = json.data[0].id;
    } catch (e) {
      console.warn('自动选择 task 失败:', e.message);
    }
  }
  console.log('使用 TASK_ID:', taskId);

  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1600,1100',
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
    await new Promise((r) => setTimeout(r, WAIT_MS));

    const sel = await send('Runtime.evaluate', {
      expression: `(async function() {
        try {
          for (let i = 0; i < 30; i++) {
            if (window.Tasks && window.Sessions && window.Core) break;
            await new Promise(r => setTimeout(r, 200));
          }
          if (window.Main && window.Main.switchTab) window.Main.switchTab('chat');
          await new Promise(r => setTimeout(r, 600));
          if (window.Sessions && window.Sessions.loadSessions) await window.Sessions.loadSessions();
          await new Promise(r => setTimeout(r, 600));
          if (window.Tasks && window.Tasks.selectTask && '${taskId}') {
            window.Tasks.selectTask('${taskId}');
          } else if (window.Tasks && window.Tasks.loadTasks) {
            await window.Tasks.loadTasks();
          }
          await new Promise(r => setTimeout(r, 1500));
          return JSON.stringify({
            currentTask: window.state && window.state.currentTaskId,
            detailBodyLen: (document.getElementById('detail-body') || {}).innerHTML ? document.getElementById('detail-body').innerHTML.length : 0,
            hasKBSection: !!document.querySelector('.kb-retrieval-section'),
            kbHitCount: (document.querySelector('.kb-retrieval-section') || {}).querySelectorAll ? document.querySelector('.kb-retrieval-section').querySelectorAll('.kb-retrieval-item').length : 0,
            kbEmpty: !!(document.querySelector('.kb-retrieval-section.empty')),
            hasModelRouting: !!document.querySelector('[title^="source:"]'),
            detailMeta: Array.from(document.querySelectorAll('.detail-meta-label')).map(e => e.textContent.trim()).join('|')
          });
        } catch (e) {
          return 'error: ' + e.message + ' ' + e.stack;
        }
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('DOM state:', sel.result.value);

    console.log('console logs (first 20):');
    logs.slice(0, 20).forEach(l => console.log('  ', l));

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
