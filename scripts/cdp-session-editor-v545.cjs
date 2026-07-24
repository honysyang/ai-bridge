// v5.4.5: 截图会话编辑器（自动补全版）
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = 9230;
const URL = 'http://127.0.0.1:4567/';
const OUT = '/tmp/session-editor-v545.png';

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
        for (let i = 0; i < 30; i++) {
          if (window.Sessions && window.Sessions.createSession) break;
          await new Promise(r => setTimeout(r, 200));
        }
        await window.Sessions.createSession();
        await new Promise(r => setTimeout(r, 1200));
        const modal = document.querySelector('.modal');
        const dirInput = document.querySelector('input.project-dir-input');
        const suggestEl = document.querySelector('.project-dir-suggest');
        const statusEl = document.querySelector('.project-dir-status');
        return JSON.stringify({
          modalOpen: !!modal,
          dirInputExists: !!dirInput,
          dirInputValue: dirInput ? dirInput.value : null,
          suggestVisible: suggestEl ? getComputedStyle(suggestEl).display !== 'none' : null,
          statusText: statusEl ? statusEl.textContent.trim() : null
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('Initial:', r.result.value);

    // 在 project_dir 输入框中输入 /ho，看补全
    const r2 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const inp = document.querySelector('input.project-dir-input');
        inp.focus();
        inp.value = '/ho';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));
        const suggestEl = document.querySelector('.project-dir-suggest');
        const statusEl = document.querySelector('.project-dir-status');
        const items = suggestEl ? Array.from(suggestEl.querySelectorAll('.suggest-item')).map(el => ({
          name: el.querySelector('.suggest-name').textContent,
          path: el.querySelector('.suggest-path').textContent,
          hasMarker: !!el.querySelector('.suggest-marker')
        })) : [];
        return JSON.stringify({
          inputValue: inp.value,
          suggestCount: items.length,
          items,
          statusText: statusEl.textContent.trim()
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('After /ho:', r2.result.value);

    // 输入 /home/ka 看补全
    const r3 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const inp = document.querySelector('input.project-dir-input');
        inp.value = '/home/ka';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));
        const suggestEl = document.querySelector('.project-dir-suggest');
        const items = suggestEl ? Array.from(suggestEl.querySelectorAll('.suggest-item')).map(el => ({
          name: el.querySelector('.suggest-name').textContent,
          path: el.querySelector('.suggest-path').textContent
        })) : [];
        return JSON.stringify({
          inputValue: inp.value,
          suggestCount: items.length,
          items
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('After /home/ka:', r3.result.value);

    // 点击第一个候选项（自动补全）
    const r4 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const inp = document.querySelector('input.project-dir-input');
        // 模拟点击第一个候选
        const first = document.querySelector('.project-dir-suggest .suggest-item');
        if (!first) return 'no item';
        const ev = new MouseEvent('mousedown', { bubbles: true });
        first.dispatchEvent(ev);
        await new Promise(r => setTimeout(r, 700));
        // 继续输入 "ai"
        inp.value = inp.value + 'ai';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));
        const suggestEl = document.querySelector('.project-dir-suggest');
        const statusEl = document.querySelector('.project-dir-status');
        const confirmBtn = document.querySelector('[data-action="confirm"]');
        const items = suggestEl ? Array.from(suggestEl.querySelectorAll('.suggest-item')).map(el => ({
          name: el.querySelector('.suggest-name').textContent,
          marker: el.querySelector('.suggest-marker') ? '📦' : null
        })) : [];
        return JSON.stringify({
          inputValue: inp.value,
          suggestCount: items.length,
          items,
          statusText: statusEl.textContent.trim(),
          confirmDisabled: confirmBtn.disabled
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('After click + /ai:', r4.result.value);

    // 完整输入有效路径，触发 blur 校验
    const r5 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const inp = document.querySelector('input.project-dir-input');
        inp.value = '/home/kali/ai-bridge';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1200));
        const statusEl = document.querySelector('.project-dir-status');
        const confirmBtn = document.querySelector('[data-action="confirm"]');
        return JSON.stringify({
          statusText: statusEl.textContent.trim(),
          confirmDisabled: confirmBtn.disabled
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('After valid path blur:', r5.result.value);

    // 输入无效路径测试
    const r6 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const inp = document.querySelector('input.project-dir-input');
        inp.value = '/nonexistent/foo';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1200));
        const statusEl = document.querySelector('.project-dir-status');
        const confirmBtn = document.querySelector('[data-action="confirm"]');
        return JSON.stringify({
          statusText: statusEl.textContent.trim(),
          confirmDisabled: confirmBtn.disabled
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    console.log('After invalid path blur:', r6.result.value);

    // 截一张清晰的最终图（恢复到有效路径 + 候选项可见）
    const r7 = await send('Runtime.evaluate', {
      expression: `(async function() {
        const inp = document.querySelector('input.project-dir-input');
        inp.focus();
        inp.value = '/home/kali/ai';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 800));
        return 'ok';
      })()`,
      returnByValue: true,
      awaitPromise: true
    });

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
