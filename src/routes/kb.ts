import { Router } from 'express';
import multer from 'multer';
import * as mime from 'mime-types';
import { taskQueue } from '../task-queue.js';
import { kbStore } from '../kb-store.js';
import { scenarioStore } from '../scenario-store.js';
import { scenarioKBLinkStore } from '../scenario-kb-link-store.js';
import { kbChunkStore } from '../kb-chunk-store.js';
import { kbLinkStore } from '../kb-link-store.js';
import { searchKBAsync, formatKBContextForPrompt } from '../lib/kb-retriever.js';
import { ingestFile, ingestUrl, ingestRepo, ingestMessage } from '../lib/ingestion.js';
import { BUILTIN_KB_TAGS } from '../lib/kb-tags.js';
import { asyncHandler } from '../middleware/error.js';

// v5.6.0: 文件上传配置
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/plain',
      'text/markdown',
      'text/html',
      'application/xhtml+xml',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
    if (allowed.includes(mimeType as string)) {
      cb(null, true);
      return;
    }
    // 也允许通过扩展名判断
    const ext = file.originalname?.toLowerCase() || '';
    if (/\.(txt|md|html|htm|pdf|doc|docx)$/i.test(ext)) {
      cb(null, true);
      return;
    }
    cb(new Error(`不支持的文件类型: ${mimeType}`));
  }
});

/**
 * 知识库路由（分类 / 条目 / 关联 / Ingestion）
 * - GET    /api/kb              列出全部（含 links、scenarios）
 * - POST   /api/kb/seed-demo    追加演示数据
 * - GET    /api/kb/scenarios    列出场景
 * - POST   /api/kb/scenarios    创建场景
 * - PATCH  /api/kb/scenarios/:id
 * - DELETE /api/kb/scenarios/:id
 * - GET    /api/kb/tags         内置标签池
 * - POST   /api/kb/categories   创建分类
 * - PATCH  /api/kb/categories/:id
 * - DELETE /api/kb/categories/:id
 * - POST   /api/kb/items        创建条目
 * - PATCH  /api/kb/items/:id
 * - DELETE /api/kb/items/:id    级联删除关联
 *
 * v5.6.0: Ingestion
 * - POST   /api/kb/upload       上传文件（PDF/HTML/Markdown/TXT/DOCX）
 * - POST   /api/kb/ingest-url   抓取网页 URL
 * - POST   /api/kb/from-message 从聊天消息创建
 *
 * - GET    /api/kb/links        列出关联（可按 item_id 过滤）
 * - POST   /api/kb/links/seed-demo
 * - POST   /api/kb/links
 * - DELETE /api/kb/links/:id
 *
 * v5.5.2: RAG 检索
 * - POST   /api/kb/search       关键词/向量/混合检索
 */
export const kbRouter = Router();

// ======== 列表（categories + items + links）=======
// v5.5.6: 支持 items 分页 / 搜索 / 分类过滤
kbRouter.get(
  '/',
  asyncHandler((req, res) => {
    const data = kbStore.list();
    const links = kbLinkStore.list();

    let items = data.items;
    let categories = data.categories;
    const q = ((req.query.search as string) || '').trim().toLowerCase();
    const catId = (req.query.category_id as string) || '';
    const scenarioId = (req.query.scenario_id as string) || '';

    if (scenarioId) {
      items = items.filter((i) => i.scenario_id === scenarioId);
      categories = categories.filter((c) => c.scenario_id === scenarioId);
    }
    if (catId) {
      items = items.filter((i) => i.category_id === catId);
    }
    if (q) {
      items = items.filter(
        (i) =>
          (i.title || '').toLowerCase().includes(q) ||
          (i.body || '').toLowerCase().includes(q) ||
          (i.tags || []).some((t) => (t || '').toLowerCase().includes(q))
      );
    }

    const total = items.length;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit as string, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);
    const paginatedItems = items.slice(offset, offset + limit);

    res.json({
      success: true,
      data: {
        scenarios: scenarioStore.list(),
        categories,
        items: paginatedItems,
        links: links.links
      },
      meta: { total_count: total, limit, offset, has_more: offset + paginatedItems.length < total }
    });
  })
);

// ======== 场景（Scenario）CRUD =====
kbRouter.get(
  '/scenarios',
  asyncHandler((_req, res) => {
    res.json({ success: true, data: scenarioStore.list() });
  })
);

kbRouter.post(
  '/scenarios',
  asyncHandler((req, res) => {
    const { name, icon, description } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name 必填且非空' });
    }
    const scenario = scenarioStore.create(name.trim(), icon, description);
    taskQueue.addLog('info', 'kb', `KB 场景创建: ${scenario.id} (${scenario.name})`, { scenario_id: scenario.id });
    res.json({ success: true, data: scenario });
  })
);

kbRouter.patch(
  '/scenarios/:id',
  asyncHandler((req, res) => {
    const { name, icon, description } = req.body || {};
    const updated = scenarioStore.update(req.params.id, { name, icon, description });
    if (!updated) {
      return res.status(404).json({ success: false, error: '场景不存在' });
    }
    res.json({ success: true, data: updated });
  })
);

kbRouter.delete(
  '/scenarios/:id',
  asyncHandler((req, res) => {
    const ok = scenarioStore.delete(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '场景不存在' });
    }
    const cascaded = scenarioKBLinkStore.cascadeDeleteForScenario(req.params.id);
    taskQueue.addLog('warn', 'kb', `KB 场景删除: ${req.params.id}`, {
      scenario_id: req.params.id,
      cascaded_links: cascaded
    });
    res.json({ success: true, data: { id: req.params.id, cascaded_links: cascaded } });
  })
);

// ======== 内置标签池 =====
kbRouter.get(
  '/tags',
  asyncHandler((_req, res) => {
    res.json({ success: true, data: BUILTIN_KB_TAGS });
  })
);

// ======== 演示数据追加 =====
kbRouter.post(
  '/seed-demo',
  asyncHandler((_req, res) => {
    const result = kbStore.seedDemo();
    const all = kbStore.list();
    const linksResult = kbLinkStore.seedDemo(all.items);
    taskQueue.addLog(
      'info',
      'kb',
      `KB 演示追加: ${result.categories_added} 分类 / ${result.items_added} 条目 / ${linksResult.links_added} 关联`
    );
    res.json({
      success: true,
      data: {
        categories_added: result.categories_added,
        items_added: result.items_added,
        links_added: linksResult.links_added,
        links_skipped: linksResult.links_skipped
      },
      message: `新增 ${result.categories_added} 分类 / ${result.items_added} 条目 / ${linksResult.links_added} 关联`
    });
  })
);

// ======== 分类 CRUD =====
kbRouter.post(
  '/categories',
  asyncHandler((req, res) => {
    const { name, icon, scenario_id } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name 必填且非空' });
    }
    const cat = kbStore.createCategory(name, icon, scenario_id);
    taskQueue.addLog('info', 'kb', `KB 分类创建: ${cat.id} (${cat.name})`, {
      kb_id: cat.id,
      scenario_id: cat.scenario_id
    });
    res.json({ success: true, data: cat });
  })
);

kbRouter.patch(
  '/categories/:id',
  asyncHandler((req, res) => {
    const { name, icon, scenario_id } = req.body || {};
    const updated = kbStore.updateCategory(req.params.id, { name, icon, scenario_id });
    if (!updated) {
      return res.status(404).json({ success: false, error: '分类不存在' });
    }
    res.json({ success: true, data: updated });
  })
);

kbRouter.delete(
  '/categories/:id',
  asyncHandler((req, res) => {
    const ok = kbStore.deleteCategory(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '分类不存在' });
    }
    taskQueue.addLog('warn', 'kb', `KB 分类删除: ${req.params.id}`, { kb_id: req.params.id });
    res.json({ success: true, data: { id: req.params.id } });
  })
);

// ======== 条目 CRUD =====
kbRouter.post(
  '/items',
  asyncHandler((req, res) => {
    const { category_id, scenario_id, title, body, tags, source_type, source_url, source_metadata, content_type } =
      req.body || {};
    if (!title || typeof title !== 'string' || !body || typeof body !== 'string') {
      return res.status(400).json({ success: false, error: 'title / body 必填且非空' });
    }
    const item = kbStore.createItem(category_id || '__orphan__', title, body, tags, {
      scenario_id,
      source_type,
      source_url,
      source_metadata,
      content_type
    });
    if (!item) {
      return res.status(400).json({ success: false, error: 'category_id 不存在' });
    }
    // 后台异步建立索引
    kbStore.reindexItem(item.id).catch(() => {});
    taskQueue.addLog('info', 'kb', `KB 条目创建: ${item.id} (${item.title})`, { kb_id: item.id });
    res.json({ success: true, data: item });
  })
);

// v5.6.0: 从聊天消息保存到知识库
kbRouter.post(
  '/from-message',
  asyncHandler(async (req, res) => {
    const { message, title, category_id, scenario_id, tags } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'message 必填且非空' });
    }
    const result = await ingestMessage(message, title, category_id || '__orphan__', tags, scenario_id);
    taskQueue.addLog('info', 'kb', `KB 从消息创建: ${result.item_id} (${result.title})`, { kb_id: result.item_id });
    res.json({ success: true, data: result });
  })
);

// v5.6.0: 上传文件到知识库
kbRouter.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: '缺少文件' });
    }
    const { category_id, scenario_id, tags } = req.body || {};
    const tagList = tags ? (Array.isArray(tags) ? tags : String(tags).split(',')) : [];
    const mimeType = file.mimetype || (mime.lookup(file.originalname) as string) || 'application/octet-stream';
    const result = await ingestFile(
      file.buffer,
      mimeType,
      file.originalname,
      category_id || '__orphan__',
      tagList,
      scenario_id
    );
    taskQueue.addLog('info', 'kb', `KB 文件上传: ${result.item_id} (${result.title}, ${result.mime_type})`, {
      kb_id: result.item_id,
      mime_type: result.mime_type,
      char_count: result.char_count,
      chunks: result.chunks
    });
    res.json({ success: true, data: result });
  })
);

// v5.6.0: 抓取 URL 到知识库
kbRouter.post(
  '/ingest-url',
  asyncHandler(async (req, res) => {
    const { url, category_id, scenario_id, tags } = req.body || {};
    if (!url || typeof url !== 'string' || !url.trim().startsWith('http')) {
      return res.status(400).json({ success: false, error: 'url 必填且需以 http/https 开头' });
    }
    const tagList = tags ? (Array.isArray(tags) ? tags : String(tags).split(',')) : [];
    const result = await ingestUrl(url.trim(), category_id || '__orphan__', tagList, scenario_id);
    taskQueue.addLog('info', 'kb', `KB URL 抓取: ${result.item_id} (${result.url})`, {
      kb_id: result.item_id,
      url: result.url,
      char_count: result.char_count,
      chunks: result.chunks
    });
    res.json({ success: true, data: result });
  })
);

// v5.6.0: 克隆代码仓库到知识库
kbRouter.post(
  '/ingest-repo',
  asyncHandler(async (req, res) => {
    const { repo_url, branch, depth, category_id, scenario_id, tags } = req.body || {};
    if (
      !repo_url ||
      typeof repo_url !== 'string' ||
      (!repo_url.trim().startsWith('http') && !repo_url.trim().startsWith('git@'))
    ) {
      return res.status(400).json({ success: false, error: 'repo_url 必填且需为 http/https/git@ 地址' });
    }
    const tagList = tags ? (Array.isArray(tags) ? tags : String(tags).split(',')) : [];
    const result = await ingestRepo(
      repo_url.trim(),
      category_id || '__orphan__',
      tagList,
      branch,
      depth && Number(depth) > 0 ? Number(depth) : 1,
      scenario_id
    );
    taskQueue.addLog('info', 'kb', `KB 仓库克隆: ${result.item_id} (${result.repo_url}, ${result.file_count} 文件)`, {
      kb_id: result.item_id,
      repo_url: result.repo_url,
      branch: result.branch,
      commit: result.commit,
      file_count: result.file_count,
      chunks: result.chunks
    });
    res.json({ success: true, data: result });
  })
);

// v5.6.0: 重新索引指定条目
kbRouter.post(
  '/items/:id/reindex',
  asyncHandler(async (req, res) => {
    const result = await kbStore.reindexItem(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: '条目不存在' });
    }
    taskQueue.addLog('info', 'kb', `KB 重新索引: ${req.params.id}, chunks=${result.chunks}, status=${result.status}`);
    res.json({ success: true, data: result });
  })
);

// v5.6.0: 重新索引所有 pending/failed 条目
kbRouter.post(
  '/reindex-all',
  asyncHandler(async (_req, res) => {
    const pending = Array.from(kbStore.list().items).filter(
      (i) => i.index_status === 'pending' || i.index_status === 'failed'
    );
    let indexed = 0;
    for (const item of pending) {
      const r = await kbStore.reindexItem(item.id);
      if (r && r.status === 'indexed') indexed++;
    }
    taskQueue.addLog('info', 'kb', `KB 批量重新索引完成: ${indexed}/${pending.length}`);
    res.json({ success: true, data: { total: pending.length, indexed } });
  })
);

kbRouter.patch(
  '/items/:id',
  asyncHandler((req, res) => {
    const updated = kbStore.updateItem(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ success: false, error: '条目不存在' });
    }
    res.json({ success: true, data: updated });
  })
);

kbRouter.delete(
  '/items/:id',
  asyncHandler((req, res) => {
    const id = req.params.id;
    const ok = kbStore.deleteItem(id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '条目不存在' });
    }
    kbChunkStore.deleteByItem(id);
    const cascaded = kbLinkStore.cascadeDeleteForItem(id);
    taskQueue.addLog('warn', 'kb', `KB 条目删除: ${id}`, { kb_id: id, cascaded_links: cascaded });
    res.json({ success: true, data: { id, cascaded_links: cascaded } });
  })
);

// ======== 关联（知识图谱）=======
kbRouter.get(
  '/links',
  asyncHandler((req, res) => {
    const itemId = req.query.item_id as string | undefined;
    const data = itemId ? { links: kbLinkStore.getForItem(itemId) } : kbLinkStore.list();
    res.json({ success: true, data: { ...data, total: data.links.length } });
  })
);

kbRouter.post(
  '/links/seed-demo',
  asyncHandler((_req, res) => {
    const all = kbStore.list();
    const result = kbLinkStore.seedDemo(all.items);
    taskQueue.addLog('info', 'kb', `KB 关联演示: 新增 ${result.links_added} 条，跳过 ${result.links_skipped} 条`);
    res.json({ success: true, data: result, message: `新增 ${result.links_added} 条关联` });
  })
);

kbRouter.post(
  '/links',
  asyncHandler((req, res) => {
    const { source_id, target_id, type, label } = req.body || {};
    if (!source_id || !target_id) {
      return res.status(400).json({ success: false, error: 'source_id 和 target_id 必填' });
    }
    if (!kbStore.getItem(source_id)) {
      return res.status(400).json({ success: false, error: `源条目不存在: ${source_id}` });
    }
    if (!kbStore.getItem(target_id)) {
      return res.status(400).json({ success: false, error: `目标条目不存在: ${target_id}` });
    }
    const result = kbLinkStore.create(source_id, target_id, type || 'related', label);
    if ('error' in result) {
      return res.status(400).json({ success: false, error: result.error });
    }
    taskQueue.addLog('info', 'kb', `KB 关联创建: ${result.source_id} → ${result.target_id} (${result.type})`, {
      link_id: result.id
    });
    res.json({ success: true, data: result });
  })
);

kbRouter.delete(
  '/links/:id',
  asyncHandler((req, res) => {
    const ok = kbLinkStore.delete(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '关联不存在' });
    }
    taskQueue.addLog('warn', 'kb', `KB 关联删除: ${req.params.id}`);
    res.json({ success: true, data: { id: req.params.id } });
  })
);

// ======== v5.5.2: RAG 检索 ========
//
// POST /api/kb/search
//   body: { query, topK?, minScore?, maxBodyChars?, includeArchived?, format? }
//   format='items' (default) → 返回 items 数组
//   format='context'         → 返回格式化 prompt 文本
//   format='both'            → items + context 都返回
//
// 注意：必须在 :id 静态路径之后注册（但本路由只有 /search 一个子路径）
kbRouter.post(
  '/search',
  asyncHandler(async (req, res) => {
    const {
      query,
      topK = 3,
      minScore = 1,
      maxBodyChars = 200,
      includeArchived = false,
      mode = 'hybrid',
      format = 'both'
    } = req.body || {};

    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, error: 'query 必填且非空' });
    }
    const opts = {
      topK: Math.min(Math.max(parseInt(String(topK)) || 3, 1), 20),
      minScore: Math.max(parseInt(String(minScore)) || 1, 0),
      maxBodyChars: Math.min(Math.max(parseInt(String(maxBodyChars)) || 200, 50), 2000),
      includeArchived: !!includeArchived,
      mode: ['keyword', 'vector', 'hybrid'].includes(mode) ? mode : 'hybrid'
    };

    const items = await searchKBAsync(query.trim(), opts);
    const context = formatKBContextForPrompt(items);

    const data: any = {
      query: query.trim(),
      hit_count: items.length,
      options: opts
    };
    if (format === 'items' || format === 'both') {
      data.items = items.map((it) => ({
        id: it.id,
        category_id: it.category_id,
        category_name: it.category_name,
        title: it.title,
        body_preview: it.body_preview,
        tags: it.tags,
        score: it.score,
        matched_keywords: it.matched_keywords,
        chunk_source_path: it.chunk_source_path
      }));
    }
    if (format === 'context' || format === 'both') {
      data.context = context;
    }
    res.json({ success: true, data });
  })
);
