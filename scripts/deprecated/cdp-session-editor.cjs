// v5.4.4: 截图会话编辑器（含项目目录预设下拉）
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9227;
const URL = 'http://127.0.0.1:4567/';
const OUT = '/tmp/session-editor.png';

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
    await new Promise((r) => setTimeout(r, 8000));

    // 等 Sessions + 打开创建 modal
    const r = await send('Runtime.evaluate', {
      expression: `(async function() {
        for (let i = 0; i < 30; i++) {
          if (window.Sessions && global.Sessions) break;
          await new Promise(r => setTimeout(r, 200));
        }
        await window.Sessions.createSession();
        await new Promise(r => setTimeout(r, 1000));
        // 检查 modal 是否出现
        const modal = document.querySelector('.modal');
        const presetSel = document.querySelector('select.project-dir-preset');
        const dirInput = document.querySelector('input.project-dir-input');
        const statusEl = document.querySelector('.project-dir-status');
        return JSON.stringify({
          modalOpen: !!modal,
          presetCount: presetSel ? presetSel.querySelectorAll('option').length : 0,
          dirInputExists: !!dirInput,
          statusText: statusEl ? statusEl.textContent.trim() : null
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('UI check:', r.result.value);

    // 选第一个 preset，看是否自动填入
    const r2 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const sel = document.querySelector('select.project-dir-preset');
        if (!sel) return 'no select';
        // 选第 8 个（应该是 discovered 中的第一个）
        const opts = Array.from(sel.options);
        let idx = 0;
        for (let i = 0; i < opts.length; i++) {
          if (opts[i].dataset.category === 'discovered') { idx = i; break; }
        }
        sel.value = opts[idx].value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1500));
        const inp = document.querySelector('input.project-dir-input');
        const status = document.querySelector('.project-dir-status');
        return JSON.stringify({
          selected: sel.value,
          inputValue: inp.value,
          statusText: status.textContent.trim(),
          statusClass: status.querySelector('[class^="dir-status-"]') ? status.querySelector('[class^="dir-status-"]').className : null
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('After preset select:', r2.result.value);

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
