// v5.4.4: 截图会话编辑器（含项目目录预设下拉）
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9229;
const URL = 'http://127.0.0.1:4567/';
const OUT = '/tmp/session-editor-v544.png';

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
    await new Promise((r) => setTimeout(r, 10000));

    // 打开 create session modal
    const r = await send('Runtime.evaluate', {
      expression: `(async function() {
        // 等 Sessions 模块
        for (let i = 0; i < 30; i++) {
          if (window.Sessions && window.Sessions.createSession) break;
          await new Promise(r => setTimeout(r, 200));
        }
        await window.Sessions.createSession();
        await new Promise(r => setTimeout(r, 1200));
        // 检查 modal
        const modal = document.querySelector('.modal');
        const presetSel = document.querySelector('select.project-dir-preset');
        const dirInput = document.querySelector('input.project-dir-input');
        const statusEl = document.querySelector('.project-dir-status');
        return JSON.stringify({
          modalOpen: !!modal,
          modalHeader: modal ? modal.querySelector('.modal-header').textContent : null,
          presetOptions: presetSel ? Array.from(presetSel.options).map(o => ({ value: o.value, label: o.textContent, category: o.dataset.category })) : [],
          dirInputExists: !!dirInput,
          dirInputValue: dirInput ? dirInput.value : null,
          statusText: statusEl ? statusEl.textContent.trim() : null
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('UI check (create modal):', r.result.value);

    // 选第一个 discovered preset
    const r2 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const sel = document.querySelector('select.project-dir-preset');
        if (!sel) return 'no select';
        const opts = Array.from(sel.options);
        let target = null;
        for (const o of opts) {
          if (o.dataset.category === 'discovered') { target = o; break; }
        }
        if (!target) target = opts[1];
        sel.value = target.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1500));
        const inp = document.querySelector('input.project-dir-input');
        const status = document.querySelector('.project-dir-status');
        return JSON.stringify({
          selectedValue: sel.value,
          selectedLabel: target.textContent,
          inputValue: inp.value,
          statusText: status.textContent.trim(),
          statusClass: status.querySelector('[class^="dir-status-"]') ? status.querySelector('[class^="dir-status-"]').className : null
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('After preset select:', r2.result.value);

    // 再测一个手动输入错误路径
    const r3 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const sel = document.querySelector('select.project-dir-preset');
        const inp = document.querySelector('input.project-dir-input');
        sel.value = '';
        inp.value = '/nonexistent/path/test';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1500));
        const status = document.querySelector('.project-dir-status');
        return JSON.stringify({
          statusText: status.textContent.trim(),
          statusClass: status.querySelector('[class^="dir-status-"]') ? status.querySelector('[class^="dir-status-"]').className : null
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('After bad input:', r3.result.value);

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
