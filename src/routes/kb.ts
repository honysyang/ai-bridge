import { Router } from 'express';
import { taskQueue } from '../task-queue.js';
import { kbStore } from '../kb-store.js';
import { kbLinkStore } from '../kb-link-store.js';
import { asyncHandler } from '../middleware/error.js';

/**
 * 知识库路由（分类 / 条目 / 关联）
 * - GET    /api/kb              列出全部（含 links）
 * - POST   /api/kb/seed-demo    追加演示数据
 * - POST   /api/kb/categories   创建分类
 * - PATCH  /api/kb/categories/:id
 * - DELETE /api/kb/categories/:id
 * - POST   /api/kb/items        创建条目
 * - PATCH  /api/kb/items/:id
 * - DELETE /api/kb/items/:id    级联删除关联
 *
 * - GET    /api/kb/links        列出关联（可按 item_id 过滤）
 * - POST   /api/kb/links/seed-demo
 * - POST   /api/kb/links
 * - DELETE /api/kb/links/:id
 */
export const kbRouter = Router();

// ======== 列表（categories + items + links）=======
kbRouter.get('/', asyncHandler((_req, res) => {
  const data = kbStore.list();
  const links = kbLinkStore.list();
  res.json({ success: true, data: { ...data, links: links.links } });
}));

// ======== 演示数据追加 =====
kbRouter.post('/seed-demo', asyncHandler((_req, res) => {
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
}));

// ======== 分类 CRUD =====
kbRouter.post('/categories', asyncHandler((req, res) => {
  const { name, icon } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'name 必填且非空' });
  }
  const cat = kbStore.createCategory(name, icon);
  taskQueue.addLog('info', 'kb', `KB 分类创建: ${cat.id} (${cat.name})`, { kb_id: cat.id });
  res.json({ success: true, data: cat });
}));

kbRouter.patch('/categories/:id', asyncHandler((req, res) => {
  const updated = kbStore.updateCategory(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ success: false, error: '分类不存在' });
  }
  res.json({ success: true, data: updated });
}));

kbRouter.delete('/categories/:id', asyncHandler((req, res) => {
  const ok = kbStore.deleteCategory(req.params.id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '分类不存在' });
  }
  taskQueue.addLog('warn', 'kb', `KB 分类删除: ${req.params.id}`, { kb_id: req.params.id });
  res.json({ success: true, data: { id: req.params.id } });
}));

// ======== 条目 CRUD =====
kbRouter.post('/items', asyncHandler((req, res) => {
  const { category_id, title, body, tags } = req.body || {};
  if (!title || typeof title !== 'string' || !body || typeof body !== 'string') {
    return res.status(400).json({ success: false, error: 'title / body 必填且非空' });
  }
  const item = kbStore.createItem(category_id || '__orphan__', title, body, tags);
  if (!item) {
    return res.status(400).json({ success: false, error: 'category_id 不存在' });
  }
  taskQueue.addLog('info', 'kb', `KB 条目创建: ${item.id} (${item.title})`, { kb_id: item.id });
  res.json({ success: true, data: item });
}));

kbRouter.patch('/items/:id', asyncHandler((req, res) => {
  const updated = kbStore.updateItem(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ success: false, error: '条目不存在' });
  }
  res.json({ success: true, data: updated });
}));

kbRouter.delete('/items/:id', asyncHandler((req, res) => {
  const id = req.params.id;
  const ok = kbStore.deleteItem(id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '条目不存在' });
  }
  const cascaded = kbLinkStore.cascadeDeleteForItem(id);
  taskQueue.addLog('warn', 'kb', `KB 条目删除: ${id}`, { kb_id: id, cascaded_links: cascaded });
  res.json({ success: true, data: { id, cascaded_links: cascaded } });
}));

// ======== 关联（知识图谱）=======
kbRouter.get('/links', asyncHandler((req, res) => {
  const itemId = req.query.item_id as string | undefined;
  const data = itemId ? { links: kbLinkStore.getForItem(itemId) } : kbLinkStore.list();
  res.json({ success: true, data: { ...data, total: data.links.length } });
}));

kbRouter.post('/links/seed-demo', asyncHandler((_req, res) => {
  const all = kbStore.list();
  const result = kbLinkStore.seedDemo(all.items);
  taskQueue.addLog('info', 'kb', `KB 关联演示: 新增 ${result.links_added} 条，跳过 ${result.links_skipped} 条`);
  res.json({ success: true, data: result, message: `新增 ${result.links_added} 条关联` });
}));

kbRouter.post('/links', asyncHandler((req, res) => {
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
  taskQueue.addLog('info', 'kb', `KB 关联创建: ${result.source_id} → ${result.target_id} (${result.type})`, { link_id: result.id });
  res.json({ success: true, data: result });
}));

kbRouter.delete('/links/:id', asyncHandler((req, res) => {
  const ok = kbLinkStore.delete(req.params.id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '关联不存在' });
  }
  taskQueue.addLog('warn', 'kb', `KB 关联删除: ${req.params.id}`);
  res.json({ success: true, data: { id: req.params.id } });
}));
