/* ============================================================
   api.js — fetch 封装 + 通用 UI 工具
   - 自动携带 Authorization: Bearer <ab_token>
   - 401 自动跳转登录页
   - get / post / patch / del
   - 附：toast / modal / drawer / 格式化 / JSON 高亮 等公共助手
   ============================================================ */

const TOKEN_KEY = 'ab_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('ab_user');
}
export function currentUser() {
  try { return JSON.parse(localStorage.getItem('ab_user') || '{}'); } catch { return {}; }
}

async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('网络请求失败，请检查服务是否在线');
  }
  if (res.status === 401) {
    clearToken();
    if (!location.pathname.endsWith('/login.html')) location.href = '/login.html';
    throw new Error('登录已过期');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 无响应体 */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

async function blobUrl(path, mimeType) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { headers });
  } catch {
    throw new Error('网络请求失败，请检查服务是否在线');
  }
  if (res.status === 401) {
    clearToken();
    if (!location.pathname.endsWith('/login.html')) location.href = '/login.html';
    throw new Error('登录已过期');
  }
  if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  if (mimeType) {
    return URL.createObjectURL(new Blob([blob], { type: mimeType }));
  }
  return URL.createObjectURL(blob);
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path) => request('DELETE', path),
  /** 获取受鉴权的二进制资源并返回 blob URL */
  blobUrl,
};

/* ---------------- toast ---------------- */
export function toast(message, type = 'info', duration = 3200) {
  let root = document.getElementById('toastRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toastRoot';
    root.className = 'toast-container';
    document.body.appendChild(root);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, duration - 300);
  setTimeout(() => el.remove(), duration);
}

/* ---------------- 转义与格式化 ---------------- */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 智能体/客户端上报的文本可能因编码不规范（GBK/GB18030 字节被当 UTF-8 解读）产生 mojibake，
 * 显示前尝试反向修复：
 *   1. 字符串已含 CJK → 视为正常，原样返回
 *   2. 把 charCode 当 Latin-1 字节流，依次按 utf-8 / gb18030 解码，
 *      第一个 fatal 成功的就视为正确结果。
 * 仅在显示层使用（不要写入存储）。
 */
export function fixMojibake(s) {
  if (typeof s !== 'string' || !s) return s || '';
  if (/[一-鿿]/.test(s)) return s; // 已有 CJK，假定未损坏
  if (/^[\x00-\x7f\s]*$/.test(s)) return s; // 纯 ASCII / 空白，不处理

  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s; // 含非 Latin-1 字符但又没 CJK，不强行修
    bytes[i] = c;
  }

  for (const enc of ['utf-8', 'gb18030']) {
    try {
      const t = new TextDecoder(enc, { fatal: true }).decode(bytes);
      return t; // 第一个成功解码的就用
    } catch { /* try next encoding */ }
  }
  return s;
}

/** 显示层统一入口：自动修 mojibake + HTML 转义 */
export function safeText(s) {
  return escapeHtml(fixMojibake(s));
}

/** 秒级时间戳 → 'MM-DD HH:mm:ss'（无效返回 '-'） */
export function fmtTime(ts, withSec = false) {
  if (!ts) return '-';
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  const base = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSec ? `${base}:${p(d.getSeconds())}` : base;
}

/** 两个秒级时间戳差 → 人类可读耗时 */
export function fmtDuration(start, end) {
  if (!start) return '-';
  const secs = Math.max(0, Math.round((end || Math.floor(Date.now() / 1000)) - start));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

export function truncate(s, len = 60) {
  s = String(s ?? '');
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

/** JSON 语法高亮（输入对象，输出 HTML）。内部对字符串做 mojibake 修复 */
export function jsonHighlight(obj) {
  let fixed = obj;
  try {
    fixed = JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'string' ? fixMojibake(v) : v)));
  } catch { /* 回退到原对象 */ }
  const raw = escapeHtml(JSON.stringify(fixed, null, 2));
  return raw.replace(
    /("(?:\\u[a-f0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match, str, colon) => {
      if (str) {
        return colon ? `<span class="json-key">${str}</span>${colon}` : `<span class="json-string">${str}</span>`;
      }
      if (/true|false|null/.test(match)) return `<span class="json-bool">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    }
  );
}

/* ---------------- Markdown 轻量渲染 ---------------- */
function mdEscapeHtml(s) {
  return escapeHtml(s);
}
function mdInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function mdBlock(s) {
  const lines = s.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing ```
      const codeText = code.join('\n');
      const codeId = 'md-code-' + Math.random().toString(36).slice(2, 10);
      out.push(`
        <div class="md-code-block">
          <div class="md-code-head">
            <span class="md-code-lang">${mdEscapeHtml(lang || 'code')}</span>
            <button class="btn btn-ghost btn-sm" type="button" onclick="copyMdCode('${codeId}')">复制</button>
          </div>
          <pre id="${codeId}"><code>${mdEscapeHtml(codeText)}</code></pre>
        </div>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push('<ul class="md-list">' + items.map((x) => `<li>${mdInline(mdEscapeHtml(x))}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push('<ol class="md-list">' + items.map((x) => `<li>${mdInline(mdEscapeHtml(x))}</li>`).join('') + '</ol>');
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      const level = line.match(/^(#{1,6})\s/)[1].length;
      const text = line.replace(/^#{1,6}\s+/, '');
      out.push(`<h${level + 1} class="md-h">${mdInline(mdEscapeHtml(text))}</h${level + 1}>`);
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      out.push(' ');
      i += 1;
      continue;
    }
    out.push(`<p class="md-p">${mdInline(mdEscapeHtml(line))}</p>`);
    i += 1;
  }
  return out.join('\n');
}

export function renderMarkdown(s) {
  const fixed = fixMojibake(String(s || ''));
  return mdBlock(fixed);
}

window.copyMdCode = function copyMdCode(id) {
  const el = document.getElementById(id);
  if (!el) return;
  copyText(el.textContent, '代码已复制');
};


export function emptyHTML(icon, text, tip) {
  return `<div class="empty"><div class="empty-icon">${icon}</div><p>${escapeHtml(text)}</p>${tip ? `<p class="empty-tip">${escapeHtml(tip)}</p>` : ''}</div>`;
}

export function copyText(text, tip = '已复制到剪贴板') {
  const done = () => toast(tip, 'success');
  if (navigator.clipboard && window.isSecureContext !== false) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('复制失败，请手动复制', 'error'); }
  ta.remove();
}

/* ---------------- 弹窗 ---------------- */
/**
 * openModal({ title, body, okText, onOk, wide, hideFoot })
 * body: HTML 字符串或 HTMLElement；onOk(modalEl) 返回 false 则不关闭。
 * 返回 { el, close }
 */
export function openModal({ title, body, okText = '确 定', cancelText = '取 消', onOk, wide = false, hideFoot = false }) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const modal = document.createElement('div');
  modal.className = `modal${wide ? ' modal-lg' : ''}`;
  modal.innerHTML = `
    <div class="modal-head"><h3>${escapeHtml(title)}</h3>
      <button class="modal-close" title="关闭">✕</button></div>
    <div class="modal-body"></div>
    ${hideFoot ? '' : `<div class="modal-foot">
      <button class="btn btn-cancel">${escapeHtml(cancelText)}</button>
      <button class="btn btn-primary btn-ok">${escapeHtml(okText)}</button>
    </div>`}`;
  const bodyEl = modal.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  modal.querySelector('.modal-close').addEventListener('click', close);
  if (!hideFoot) {
    modal.querySelector('.btn-cancel').addEventListener('click', close);
    modal.querySelector('.btn-ok').addEventListener('click', async () => {
      if (onOk) {
        try {
          const r = await onOk(modal);
          if (r === false) return;
        } catch (err) {
          toast(err.message || '操作失败', 'error');
          return;
        }
      }
      close();
    });
  }
  return { el: modal, close };
}

export function confirmBox(message, onOk, { title = '确认操作', okText = '确 定', danger = false } = {}) {
  openModal({
    title,
    body: `<p style="font-size:14px">${escapeHtml(message)}</p>`,
    okText,
    onOk: async (modal) => {
      if (danger) modal.querySelector('.btn-ok').classList.add('btn-danger');
      await onOk();
    },
  });
}

/* ---------------- 抽屉 ---------------- */
export function openDrawer(title, bodyHTML) {
  closeDrawer();
  const mask = document.createElement('div');
  mask.className = 'drawer-mask';
  mask.id = 'drawerMask';
  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.id = 'drawerEl';
  drawer.innerHTML = `
    <div class="drawer-head"><h3>${escapeHtml(title)}</h3>
      <button class="modal-close" title="关闭">✕</button></div>
    <div class="drawer-body">${bodyHTML || ''}</div>`;
  document.body.appendChild(mask);
  document.body.appendChild(drawer);
  mask.addEventListener('click', closeDrawer);
  drawer.querySelector('.modal-close').addEventListener('click', closeDrawer);
  return drawer.querySelector('.drawer-body');
}
export function closeDrawer() {
  document.getElementById('drawerMask')?.remove();
  document.getElementById('drawerEl')?.remove();
}

/* ---------------- 常量映射 ---------------- */
export const STATUS_MAP = {
  pending: { text: '待分配', cls: 'badge-yellow' },
  assigned: { text: '已分配', cls: 'badge-blue' },
  processing: { text: '执行中', cls: 'badge-blue' },
  completed: { text: '已完成', cls: 'badge-green' },
  failed: { text: '失败', cls: 'badge-red' },
};
export const SOURCE_MAP = {
  manual: { text: '手动', icon: '✋' },
  chat: { text: '对话', icon: '💬' },
  wechat: { text: '微信', icon: '📱' },
  scheduled: { text: '定时', icon: '⏰' },
  workflow: { text: '工作流', icon: '🔀' },
  delegation: { text: '委派', icon: '🔗' },
};
export const PRESENCE_MAP = {
  online: { text: '在线', dot: 'dot-green' },
  busy: { text: '忙碌', dot: 'dot-yellow' },
  idle: { text: '空闲', dot: 'dot-blue' },
  offline: { text: '离线', dot: 'dot-gray' },
  pending_review: { text: '待审核', dot: 'dot-orange' },
};
export function presenceBadge(p) {
  const m = PRESENCE_MAP[p] || { text: p || '未知', dot: 'dot-gray' };
  return `<span class="badge"><span class="dot ${m.dot}"></span>${m.text}</span>`;
}
export function statusBadge(s) {
  const m = STATUS_MAP[s] || { text: s || '-', cls: '' };
  return `<span class="badge ${m.cls}">${m.text}</span>`;
}
