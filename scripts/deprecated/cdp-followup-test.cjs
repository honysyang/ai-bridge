// v5.4.3: 测试 followup 提交流程
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9225;
const URL = 'http://127.0.0.1:4567/';
const OUT = '/tmp/followup-after.png';
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

    // 切到 chat + 选 task + 填入 followup + 提交
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
        // 填入 followup 内容
        const input = document.getElementById('followup-input-${TASK_ID}');
        if (input) {
          input.value = '[E2E测试] 请把概览/设置修复清单第 4 点的 UI 截图位置展开说';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 300));
        // 点击提交
        const sendBtn = document.querySelector('#detail-tab-content [data-action="followup"]');
        if (sendBtn) sendBtn.click();
        // 等待网络 + 重渲染
        await new Promise(r => setTimeout(r, 2500));
        const newTaskId = window.state && window.state.currentTaskId;
        // 拿父任务引用
        const parentRef = document.querySelector('.followup-section');
        return JSON.stringify({
          newTaskId,
          taskHeader: (document.querySelector('.task-card.selected .task-card-id') || {}).textContent,
          detailBodyLen: (document.getElementById('detail-body') || {}).innerHTML.length,
          hasFollowupBadge: !!document.querySelector('.source-badge.source-followup')
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('followup result:', r.result.value);

    // 再截图
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
