/* ============================================================
   artifact-cards.js — 成果卡片公共渲染模块（chat + tasks 共用）
   代码卡 / 文档卡 / 文件卡：预览 · 展开 · 复制 · 下载 · 阅读
   ============================================================ */
import { api, toast, escapeHtml, renderMarkdown, copyText, openDrawer, closeDrawer } from './api.js';

/** 字节大小人类可读 */
function fmtSize(n) {
  if (!n && n !== 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 代码简单着色（关键词/字符串/注释，单行级） */
function highlightCode(line, lang) {
  let s = escapeHtml(line);
  // 字符串
  s = s.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span class="cd-str">$1</span>');
  // 行注释
  s = s.replace(/(\/\/.*$)/g, '<span class="cd-cmt">$1</span>');
  // 关键词（通用）
  const kw = lang === 'python'
    ? /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|with|async|await|yield|lambda|None|True|False|and|or|not|in|is)\b/g
    : /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|extends|new|try|catch|finally|async|await|yield|typeof|instanceof|null|undefined|true|false|this|super|switch|case|break|continue|do|void|delete)\b/g;
  s = s.replace(kw, '<span class="cd-kw">$1</span>');
  // 数字
  s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="cd-num">$1</span>');
  return s;
}

/**
 * 渲染成果卡片列表 HTML
 * @param {Array} artifacts - result.artifacts 数组
 * @returns {string} HTML
 */
export function renderArtifactCards(artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length) return '';
  return `<div class="artifacts-list">${artifacts.map((a, i) => renderOne(a, i)).join('')}</div>`;
}

function renderOne(a, idx) {
  const safeName = escapeHtml(a.name || 'untitled');
  if (a.type === 'code') {
    const lang = escapeHtml(a.language || 'text');
    const lines = String(a.content || '').split('\n');
    const preview = lines.slice(0, 5).map((l) => highlightCode(l, a.language)).join('\n');
    const hasMore = lines.length > 5;
    const fullCode = escapeHtml(a.content || '');
    return `
    <div class="artifact-card art-code" data-art-idx="${idx}">
      <div class="art-head">
        <span class="art-name">📄 ${safeName}</span>
        <span class="badge badge-blue art-lang">${lang}</span>
        <span class="art-ops">
          <button class="btn btn-sm btn-ghost art-expand" title="展开/收起">⤢ 展开</button>
          <button class="btn btn-sm btn-ghost art-copy" title="复制">📋</button>
          <button class="btn btn-sm btn-ghost art-dl" title="下载">⬇</button>
        </span>
      </div>
      <pre class="art-preview"><code>${preview}${hasMore ? '\n<span class="cd-more">… 共 ' + lines.length + ' 行（点击展开）</span>' : ''}</code></pre>
      <pre class="art-full" style="display:none"><code>${fullCode}</code></pre>
    </div>`;
  }
  if (a.type === 'markdown') {
    return `
    <div class="artifact-card art-md" data-art-idx="${idx}">
      <div class="art-head">
        <span class="art-name">📝 ${safeName}</span>
        <span class="badge badge-green art-lang">md</span>
        <span class="art-ops">
          <button class="btn btn-sm btn-ghost art-read" title="阅读">📖 阅读</button>
          <button class="btn btn-sm btn-ghost art-dl" title="下载 .md">⬇</button>
        </span>
      </div>
      <div class="art-md-preview">${renderMarkdown(String(a.content || '').slice(0, 300))}${String(a.content || '').length > 300 ? '<p class="cd-more">…（点击「阅读」查看全文）</p>' : ''}</div>
    </div>`;
  }
  if (a.type === 'file') {
    const size = fmtSize(a.size);
    return `
    <div class="artifact-card art-file" data-art-idx="${idx}" data-file-id="${escapeHtml(a.file_id)}">
      <div class="art-head">
        <span class="art-name">📦 ${safeName}</span>
        <span class="badge art-lang">${size}</span>
        <span class="art-ops">
          <button class="btn btn-sm btn-ghost art-dl-file" title="下载">⬇ 下载</button>
        </span>
      </div>
    </div>`;
  }
  return '';
}

/**
 * 绑定成果卡片交互（展开/复制/下载/阅读）
 * @param {HTMLElement} container - 包含 .artifacts-list 的容器
 */
export function bindArtifactCards(container) {
  if (!container) return;
  // 代码卡：展开/收起
  container.querySelectorAll('.art-code .art-expand').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.art-code');
      const preview = card.querySelector('.art-preview');
      const full = card.querySelector('.art-full');
      const isFull = full.style.display !== 'none';
      if (isFull) {
        full.style.display = 'none';
        preview.style.display = '';
        btn.textContent = '⤢ 展开';
      } else {
        preview.style.display = 'none';
        full.style.display = 'block';
        btn.textContent = '⤡ 收起';
      }
    });
  });
  // 代码卡：复制
  container.querySelectorAll('.art-code .art-copy').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = btn.closest('.art-code');
      const idx = Number(card.dataset.artIdx);
      const code = card.querySelector('.art-full code')?.textContent || card.querySelector('.art-preview code')?.textContent || '';
      await copyText(code);
    });
  });
  // 代码卡：下载
  container.querySelectorAll('.art-code .art-dl').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.art-code');
      const name = card.querySelector('.art-name')?.textContent?.replace(/^📄\s*/, '') || 'code.txt';
      const code = card.querySelector('.art-full code')?.textContent || card.querySelector('.art-preview code')?.textContent || '';
      downloadText(name, code);
    });
  });
  // 文档卡：阅读（开抽屉渲染 md）
  container.querySelectorAll('.art-md .art-read').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.art-md');
      const name = card.querySelector('.art-name')?.textContent?.replace(/^📝\s*/, '') || '文档';
      // 从 artifacts 数据取回 content（通过 data-art-idx）
      const idx = Number(card.dataset.artIdx);
      const content = card._mdContent || card.querySelector('.art-md-preview')?.textContent || '';
      const body = openDrawer(`📖 ${escapeHtml(name)}`, '<div class="loading-line"><span class="spinner"></span> 加载中…</div>');
      // 尝试从 DOM 属性恢复完整 content（存于 dataset）
      const full = card.dataset.mdFull || content;
      body.innerHTML = `<div class="md-body">${renderMarkdown(full)}</div>`;
    });
  });
  // 文档卡：下载 .md
  container.querySelectorAll('.art-md .art-dl').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.art-md');
      const name = (card.querySelector('.art-name')?.textContent?.replace(/^📝\s*/, '') || 'doc') + '.md';
      const content = card.dataset.mdFull || card.querySelector('.art-md-preview')?.textContent || '';
      downloadText(name, content);
    });
  });
  // 文件卡：下载
  container.querySelectorAll('.art-file .art-dl-file').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = btn.closest('.art-file');
      const fileId = card.dataset.fileId;
      if (!fileId) return;
      try {
        // 获取元信息拿原文件名
        const meta = await api.get(`/api/files/${fileId}/meta`);
        const url = `${api.base || ''}/api/files/${fileId}/download?_t=${Date.now()}`;
        // 用 fetch 拿 blob 再触发下载（带鉴权头）
        const token = localStorage.getItem('aibr_token') || localStorage.getItem('token') || '';
        const resp = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!resp.ok) throw new Error(`下载失败：${resp.status}`);
        const blob = await resp.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = meta.name || fileId;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('下载已开始', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

/** 触发文本下载 */
function downloadText(name, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('下载已开始', 'success');
}

/**
 * 渲染成果卡片并绑定事件（便捷封装）
 * @param {HTMLElement} container
 * @param {Array} artifacts
 */
export function mountArtifactCards(container, artifacts) {
  if (!container) return;
  // 为 markdown 卡片存完整 content 到 dataset（避免回放时丢失）
  const html = renderArtifactCards(artifacts);
  container.innerHTML = html;
  // 回填 markdown 完整内容到 dataset
  if (Array.isArray(artifacts)) {
    container.querySelectorAll('.art-md').forEach((card) => {
      const idx = Number(card.dataset.artIdx);
      if (artifacts[idx]?.type === 'markdown') {
        card.dataset.mdFull = artifacts[idx].content || '';
      }
    });
  }
  bindArtifactCards(container);
}
