import express from 'express';

/**
 * 知识库 + 图谱 links + 文件导入分块 + 经验回流 + 智能检索。
 * 挂载于 /api/kb。
 * kb 集合以 kind 区分：category / item / link。
 * kb_chunks 集合存 item 分块索引：{id, item_id, seq, text, summary?}。
 */

const STOP_WORDS = new Set([
  '的', '了', '是', '和', '在', '有', '我', '他', '她', '它', '们', '这', '那', '为', '之', '与', '及', '或', '等', '对', '到', '从', '也', '就', '都', '要', '会', '能', '而', '以', '但', '来', '去', '上', '下', '中', '大', '小', '个', '你', '好', '吗', '吧', '啊', '呢', '嗯', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'and', 'but', 'or', 'yet', 'so', 'if', 'because', 'although', 'though', 'while', 'where', 'when', 'that', 'this', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
]);

/** 将文本分词为有效词元列表（英文按非词字符拆分，中文 2-gram）。 */
function tokenize(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const out = [];
  // 英文/数字词元
  const words = s.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  out.push(...words);
  // 中文 2-gram
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    const bigram = cjk.slice(i, i + 2);
    if (!STOP_WORDS.has(bigram)) out.push(bigram);
  }
  return out;
}

/** 在文本中定位词元首次出现位置，返回前后各 60 字的 snippet。 */
function snippetAround(text, terms) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let best = -1;
  let matched = '';
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx !== -1) { best = idx; matched = t; break; }
  }
  if (best === -1) return text.slice(0, 120);
  const start = Math.max(0, best - 60);
  const end = Math.min(text.length, best + matched.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/** 为 snippet 中的命中词加 <mark> 高亮。 */
function highlightSnippet(snippet, terms) {
  if (!snippet || !terms.length) return snippet;
  let html = snippet;
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

/** 按段落切分文本为 500-800 字块，重叠 50 字。 */
function splitChunks(text) {
  const paragraphs = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paragraphs) {
    if (cur.length && cur.length + p.length + 2 > 800) {
      chunks.push(cur);
      const prev = chunks[chunks.length - 1];
      cur = (prev.length >= 50 ? prev.slice(-50) : prev) + '\n\n' + p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur) {
    if (cur.length > 800 && !chunks.length) {
      // 单个段落过长，按 700 字硬切
      for (let i = 0; i < cur.length; i += 700) chunks.push(cur.slice(i, i + 700));
    } else {
      chunks.push(cur);
    }
  }
  return chunks;
}

/** 重新计算并保存 item 的分块。 */
function reindexChunks(ctx, item) {
  const chunks = ctx.store.coll('kb_chunks');
  // 先清除旧块
  for (const c of chunks.all()) {
    if (c.item_id === item.id) chunks.remove(c.id);
  }
  const text = item.content || '';
  if (text.length <= 800) return;
  const parts = splitChunks(text);
  parts.forEach((part, i) => {
    chunks.insert({
      id: ctx.util.uid('kbc'),
      item_id: item.id,
      seq: i + 1,
      text: part,
      created_at: ctx.util.now(),
    });
  });
}

/** 异步为 chunk 生成摘要（可选，AI 不可用时跳过）。 */
async function summarizeChunks(ctx, itemId) {
  const chunks = ctx.store.coll('kb_chunks');
  const ai = ctx.ai;
  if (!ai || !await ai.isAiAvailable(ctx, 'qa')) return;
  for (const c of chunks.all()) {
    if (c.item_id !== itemId || c.summary) continue;
    try {
      const r = await ai.callAI(ctx, {
        purpose: 'qa',
        messages: [
          { role: 'system', content: '请用50字以内概括以下文本的核心要点，只返回摘要本身。' },
          { role: 'user', content: c.text },
        ],
        maxTokens: 120,
      });
      if (r?.content) {
        chunks.update(c.id, { summary: String(r.content).trim().slice(0, 120) });
      }
    } catch { /* 可降级 */ }
  }
}

/** 计算两文本关键词重合度（Jaccard 近似）。 */
function overlapScore(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 搜索知识库：REST 与 MCP 复用。 */
export function searchKb(ctx, query, limit = 10) {
  const q = String(query || '').trim();
  if (!q) return { query: q, results: [] };
  const terms = tokenize(q);
  if (!terms.length) return { query: q, results: [] };
  const kb = ctx.store.coll('kb');
  const chunks = ctx.store.coll('kb_chunks');
  const items = kb.all().filter((x) => x.kind === 'item');
  const categories = Object.fromEntries(kb.all().filter((x) => x.kind === 'category').map((c) => [c.id, c]));
  const hits = [];

  for (const item of items) {
    let score = 0;
    let bestSnippet = '';
    const title = item.title || '';
    const content = item.content || '';
    const tags = (item.tags || []).join(' ');

    for (const t of terms) {
      if (title.toLowerCase().includes(t)) score += 3;
      if (tags.toLowerCase().includes(t)) score += 2;
      if (content.toLowerCase().includes(t)) score += 1;
    }

    // 分块命中
    const itemChunks = chunks.all().filter((c) => c.item_id === item.id);
    for (const c of itemChunks) {
      for (const t of terms) {
        if ((c.summary || c.text).toLowerCase().includes(t)) {
          score += 1;
          if (!bestSnippet) bestSnippet = c.summary || c.text;
        }
      }
    }

    if (score <= 0) continue;
    if (!bestSnippet) bestSnippet = snippetAround(content, terms) || snippetAround(title, terms);
    const cat = categories[item.category_id];
    hits.push({
      item,
      score,
      snippet: bestSnippet,
      category_name: cat?.name || '未分类',
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit).map((h) => ({
    id: h.item.id,
    title: h.item.title,
    category_id: h.item.category_id || null,
    category_name: h.category_name,
    score: h.score,
    snippet: h.snippet,
    tags: h.item.tags || [],
  }));
  return { query: q, terms, results: top };
}

/** 验证 agent 凭证，成功返回 agent，失败返回 null。 */
function verifyAgent(ctx, agentId, token) {
  if (!agentId || !token) return null;
  const agent = ctx.store.coll('agents').get(agentId);
  if (!agent || !agent.token_hash || !ctx.auth.verifySecret(token, agent.token_hash)) return null;
  return agent;
}

/** 鉴权中间件：Bearer 用户 或 query 的 agent_id+token（agent 须 active）。 */
function kbAuth(ctx) {
  return (req, res, next) => {
    const agentId = req.query.agent_id || req.body?.agent_id;
    const token = req.query.token || req.body?.token;
    const agent = verifyAgent(ctx, agentId, token);
    if (agent) {
      if (agent.review_status !== 'active') return res.status(403).json({ error: agent.review_status });
      req.agent = agent;
      return next();
    }
    return ctx.auth.requireUser(req, res, next);
  };
}

/** AI 建议条目关联：抽取实体并与已有条目标题匹配，生成 suggested=true 的候选 link。 */
async function aiSuggestLinks(ctx, item) {
  const ai = ctx.ai;
  if (!ai || !await ai.isAiAvailable(ctx, 'qa')) return;
  const kb = ctx.store.coll('kb');
  const others = kb.all().filter((x) => x.kind === 'item' && x.id !== item.id && x.category_id === item.category_id);
  if (!others.length) return;

  try {
    const titles = others.map((o) => `- ${o.id}: ${o.title}`).join('\n');
    const r = await ai.callAI(ctx, {
      purpose: 'qa',
      messages: [
        { role: 'system', content: '请分析给定知识条目可能与哪些已有条目相关。返回严格 JSON 数组，每项含 {id, label}，不要多余文字。' },
        { role: 'user', content: `当前条目：${item.title}\n${item.content?.slice(0, 500) || ''}\n\n候选条目：\n${titles}` },
      ],
      maxTokens: 300,
    });
    if (!r?.content) return;
    let list;
    try { list = JSON.parse(r.content); } catch { return; }
    if (!Array.isArray(list)) return;
    for (const x of list) {
      const other = others.find((o) => o.id === x.id || o.title === x.id);
      if (!other) continue;
      // 避免重复建议
      const exists = kb.all().some((l) => l.kind === 'link' && ((l.from_id === item.id && l.to_id === other.id) || (l.from_id === other.id && l.to_id === item.id)));
      if (exists) continue;
      kb.insert({
        id: ctx.util.uid('kbl'),
        kind: 'link',
        from_id: item.id,
        to_id: other.id,
        label: String(x.label || '相关').slice(0, 20),
        suggested: true,
        created_at: ctx.util.now(),
      });
    }
  } catch { /* 可降级 */ }
}

export default function (ctx) {
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;
  const kb = () => store.coll('kb');
  const chunks = () => store.coll('kb_chunks');

  // ---- categories ----
  router.get('/', ru, (req, res) => {
    const all = kb().all();
    res.json({
      categories: all.filter((x) => x.kind === 'category'),
      items: all.filter((x) => x.kind === 'item').sort((a, b) => a.created_at - b.created_at),
      links: all.filter((x) => x.kind === 'link'),
    });
  });

  router.post('/categories', ru, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const cat = kb().insert({
      id: util.uid('kbc'), kind: 'category', name,
      parent_id: req.body?.parent_id || undefined,
      created_at: util.now(),
    });
    res.status(201).json(cat);
  });

  router.patch('/categories/:id', ru, (req, res) => {
    const cat = kb().get(req.params.id);
    if (!cat || cat.kind !== 'category') return res.status(404).json({ error: 'not_found' });
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim() || cat.name;
    if (req.body?.parent_id !== undefined) patch.parent_id = req.body.parent_id || undefined;
    res.json(kb().update(cat.id, patch));
  });

  router.delete('/categories/:id', ru, (req, res) => {
    const cat = kb().get(req.params.id);
    if (!cat || cat.kind !== 'category') return res.status(404).json({ error: 'not_found' });
    const itemIds = kb().all()
      .filter((x) => x.kind === 'item' && x.category_id === cat.id)
      .map((x) => x.id);
    const gone = new Set([cat.id, ...itemIds]);
    for (const l of kb().all()) {
      if (l.kind === 'link' && (gone.has(l.from_id) || gone.has(l.to_id))) kb().remove(l.id);
    }
    for (const id of itemIds) {
      kb().remove(id);
      for (const c of chunks().all()) if (c.item_id === id) chunks().remove(c.id);
    }
    kb().remove(cat.id);
    res.json({ ok: true, removed_items: itemIds.length });
  });

  // ---- items ----
  router.post('/items', ru, (req, res) => {
    const { category_id, title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });
    if (category_id) {
      const cat = kb().get(category_id);
      if (!cat || cat.kind !== 'category') return res.status(400).json({ error: 'category not_found' });
    }
    const item = kb().insert({
      id: util.uid('kbi'), kind: 'item',
      category_id: category_id || undefined,
      title: String(title),
      content: String(content),
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [],
      extra: req.body?.extra && typeof req.body.extra === 'object' ? req.body.extra : {},
      created_at: util.now(),
      updated_at: util.now(),
    });
    reindexChunks(ctx, item);
    // 异步摘要 + AI 建议，不阻塞响应
    summarizeChunks(ctx, item.id).catch(() => {});
    aiSuggestLinks(ctx, item).catch(() => {});
    res.status(201).json(item);
  });

  router.patch('/items/:id', ru, (req, res) => {
    const item = kb().get(req.params.id);
    if (!item || item.kind !== 'item') return res.status(404).json({ error: 'not_found' });
    const patch = {};
    for (const k of ['title', 'content', 'category_id']) {
      if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    if (req.body?.tags !== undefined) {
      patch.tags = Array.isArray(req.body.tags) ? req.body.tags.map(String) : [];
    }
    if (req.body?.extra !== undefined && typeof req.body.extra === 'object') {
      patch.extra = { ...item.extra, ...req.body.extra };
    }
    patch.updated_at = util.now();
    const updated = kb().update(item.id, patch);
    if (patch.content !== undefined) {
      reindexChunks(ctx, updated);
      summarizeChunks(ctx, updated.id).catch(() => {});
    }
    aiSuggestLinks(ctx, updated).catch(() => {});
    res.json(updated);
  });

  router.delete('/items/:id', ru, (req, res) => {
    const item = kb().get(req.params.id);
    if (!item || item.kind !== 'item') return res.status(404).json({ error: 'not_found' });
    for (const l of kb().all()) {
      if (l.kind === 'link' && (l.from_id === item.id || l.to_id === item.id)) kb().remove(l.id);
    }
    for (const c of chunks().all()) {
      if (c.item_id === item.id) chunks().remove(c.id);
    }
    kb().remove(item.id);
    res.json({ ok: true });
  });

  // ---- links ----
  router.post('/links', ru, (req, res) => {
    const { from_id, to_id, label, suggested } = req.body || {};
    if (!from_id || !to_id) return res.status(400).json({ error: 'from_id and to_id required' });
    if (!kb().get(from_id) || !kb().get(to_id)) return res.status(400).json({ error: 'endpoint not_found' });
    const link = kb().insert({
      id: util.uid('kbl'), kind: 'link', from_id, to_id,
      label: label || undefined,
      suggested: suggested === true ? true : undefined,
      created_at: util.now(),
    });
    res.status(201).json(link);
  });

  router.patch('/links/:id', ru, (req, res) => {
    const link = kb().get(req.params.id);
    if (!link || link.kind !== 'link') return res.status(404).json({ error: 'not_found' });
    const patch = {};
    if (req.body?.label !== undefined) patch.label = String(req.body.label || '').trim() || undefined;
    if (req.body?.suggested === false) patch.suggested = undefined;
    if (req.body?.suggested === true) patch.suggested = true;
    res.json(kb().update(link.id, patch));
  });

  router.delete('/links/:id', ru, (req, res) => {
    const link = kb().get(req.params.id);
    if (!link || link.kind !== 'link') return res.status(404).json({ error: 'not_found' });
    kb().remove(link.id);
    res.json({ ok: true });
  });

  // ---- search：双通道鉴权 ----
  router.get('/search', kbAuth(ctx), (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const r = searchKb(ctx, req.query.q, limit);
    res.json(r);
  });

  // 保留旧 POST search 端点（兼容 chat.js 调用），内部转发到 GET 逻辑
  router.post('/search', kbAuth(ctx), (req, res) => {
    const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 50);
    const r = searchKb(ctx, req.body?.q, limit);
    res.json(r);
  });

  // ---- import-file：base64 JSON ----
  router.post('/items/:id/import-file', ru, async (req, res) => {
    const item = kb().get(req.params.id);
    if (!item || item.kind !== 'item') return res.status(404).json({ error: 'not_found' });
    const file = req.body?.file;
    if (!file || typeof file.name !== 'string' || typeof file.content_base64 !== 'string') {
      return res.status(400).json({ error: 'file.name and file.content_base64 required' });
    }
    const name = file.name.toLowerCase();
    if (!name.endsWith('.md') && !name.endsWith('.txt') && !name.endsWith('.html')) {
      return res.status(400).json({ error: 'only .md/.txt/.html supported' });
    }
    let text;
    try {
      text = Buffer.from(file.content_base64, 'base64').toString('utf8');
    } catch {
      return res.status(400).json({ error: 'invalid base64' });
    }
    if (name.endsWith('.html')) {
      // 简易 html 去标签
      text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();
    }
    const mode = req.body?.mode === 'append' ? 'append' : 'overwrite';
    const content = mode === 'append' ? `${item.content || ''}\n\n${text}` : text;
    const updated = kb().update(item.id, { content, updated_at: util.now() });
    reindexChunks(ctx, updated);
    summarizeChunks(ctx, updated.id).catch(() => {});
    res.json({ ok: true, item: updated, chars: text.length });
  });

  // ---- from-task：经验回流 ----
  router.post('/from-task', ru, (req, res) => {
    const { task_id, category_id, title, tags } = req.body || {};
    if (!task_id || !category_id) return res.status(400).json({ error: 'task_id and category_id required' });
    const cat = kb().get(category_id);
    if (!cat || cat.kind !== 'category') return res.status(400).json({ error: 'category not_found' });
    const task = store.coll('tasks').get(task_id);
    if (!task) return res.status(404).json({ error: 'task not_found' });

    const question = task.data?.content || '（无问题描述）';
    const summary = task.result?.summary || '（无结果摘要）';
    const evidence = task.result?.evidence || {};
    const commands = (evidence.executed_commands || []).map((c) => `- \`${c}\``).join('\n') || '（无）';
    const files = (evidence.read_files || []).map((f) => `- ${f}`).join('\n') || '（无）';

    const itemTitle = String(title || '').trim() || question.slice(0, 30);
    const itemContent = `## 问题\n\n${question}\n\n## 解决方案\n\n${summary}\n\n## 执行要点\n\n- 关键命令：\n${commands}\n- 读取文件：\n${files}`;

    const item = kb().insert({
      id: util.uid('kbi'), kind: 'item',
      category_id,
      title: itemTitle,
      content: itemContent,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      extra: { source_task_id: task_id },
      created_at: util.now(),
      updated_at: util.now(),
    });

    // 自动关联同分类最相似条目
    const siblings = kb().all().filter((x) => x.kind === 'item' && x.id !== item.id && x.category_id === category_id);
    let best = null;
    let bestScore = 0.3;
    for (const sib of siblings) {
      const score = overlapScore(`${item.title} ${item.content}`, `${sib.title} ${sib.content}`);
      if (score > bestScore) { bestScore = score; best = sib; }
    }
    let link = null;
    if (best) {
      link = kb().insert({
        id: util.uid('kbl'), kind: 'link',
        from_id: item.id, to_id: best.id,
        label: '相关经验', created_at: util.now(),
      });
    }

    reindexChunks(ctx, item);
    summarizeChunks(ctx, item.id).catch(() => {});
    aiSuggestLinks(ctx, item).catch(() => {});
    res.status(201).json({ item, link });
  });

  return router;
}
