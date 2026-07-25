import { Router } from 'express';
import { promptStore } from '../prompt-store.js';
import { taskQueue } from '../task-queue.js';
import { asyncHandler } from '../middleware/error.js';

/**
 * 提示词库路由
 *
 * - GET    /api/prompts              列出分类 + 提示词
 * - POST   /api/prompts/seed-demo    追加演示数据
 * - POST   /api/prompts/categories   创建分类
 * - PATCH  /api/prompts/categories/:id
 * - DELETE /api/prompts/categories/:id
 * - POST   /api/prompts              创建提示词
 * - PATCH  /api/prompts/:id
 * - DELETE /api/prompts/:id
 * - POST   /api/prompts/:id/apply    渲染变量
 * - POST   /api/prompts/:id/use      渲染并创建任务
 */
export const promptRouter = Router();

promptRouter.get(
  '/',
  asyncHandler((req, res) => {
    const data = promptStore.list();
    let prompts = data.prompts;
    const q = ((req.query.search as string) || '').trim().toLowerCase();
    const catId = (req.query.category_id as string) || '';
    if (catId) {
      prompts = prompts.filter((p) => p.category_id === catId);
    }
    if (q) {
      prompts = prompts.filter(
        (p) =>
          (p.title || '').toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q) ||
          (p.content || '').toLowerCase().includes(q) ||
          (p.tags || []).some((t) => (t || '').toLowerCase().includes(q))
      );
    }
    res.json({
      success: true,
      data: { categories: data.categories, prompts, total: data.categories.length + prompts.length }
    });
  })
);

promptRouter.post(
  '/seed-demo',
  asyncHandler((_req, res) => {
    const result = promptStore.seedDemo();
    res.json({
      success: true,
      data: result,
      message: `新增 ${result.categories_added} 分类 / ${result.prompts_added} 提示词`
    });
  })
);

// ======== 分类 CRUD ========

promptRouter.post(
  '/categories',
  asyncHandler((req, res) => {
    const { name, icon } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name 必填且非空' });
    }
    const cat = promptStore.createCategory(name, icon);
    res.json({ success: true, data: cat });
  })
);

promptRouter.patch(
  '/categories/:id',
  asyncHandler((req, res) => {
    const updated = promptStore.updateCategory(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ success: false, error: '分类不存在' });
    }
    res.json({ success: true, data: updated });
  })
);

promptRouter.delete(
  '/categories/:id',
  asyncHandler((req, res) => {
    const ok = promptStore.deleteCategory(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '分类不存在' });
    }
    res.json({ success: true, data: { id: req.params.id } });
  })
);

// ======== 提示词 CRUD ========

promptRouter.post(
  '/',
  asyncHandler((req, res) => {
    const { category_id, title, content, description, tags, variables } = req.body || {};
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'title 必填且非空' });
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'content 必填且非空' });
    }
    const tagList = Array.isArray(tags) ? tags : [];
    const prompt = promptStore.createPrompt(category_id || '__orphan__', title, content, {
      description,
      tags: tagList,
      variables: Array.isArray(variables) ? variables : undefined
    });
    if (!prompt) {
      return res.status(400).json({ success: false, error: 'category_id 不存在' });
    }
    res.json({ success: true, data: prompt });
  })
);

promptRouter.patch(
  '/:id',
  asyncHandler((req, res) => {
    const updated = promptStore.updatePrompt(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ success: false, error: '提示词不存在' });
    }
    res.json({ success: true, data: updated });
  })
);

promptRouter.delete(
  '/:id',
  asyncHandler((req, res) => {
    const ok = promptStore.deletePrompt(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: '提示词不存在' });
    }
    res.json({ success: true, data: { id: req.params.id } });
  })
);

// ======== Apply / Use ========

promptRouter.post(
  '/:id/apply',
  asyncHandler((req, res) => {
    const { variables } = req.body || {};
    const result = promptStore.apply(req.params.id, variables || {});
    if (!result) {
      return res.status(404).json({ success: false, error: '提示词不存在' });
    }
    res.json({ success: true, data: result });
  })
);

promptRouter.post(
  '/:id/use',
  asyncHandler(async (req, res) => {
    const { variables, task_type = 'generate_content', priority = 'normal', session_id } = req.body || {};
    const prompt = promptStore.getPrompt(req.params.id);
    if (!prompt) {
      return res.status(404).json({ success: false, error: '提示词不存在' });
    }
    const applied = promptStore.apply(req.params.id, variables || {});
    if (!applied) {
      return res.status(404).json({ success: false, error: '提示词不存在' });
    }
    const task = await taskQueue.addTask({
      type: task_type,
      priority,
      source: 'prompt_library',
      session_id,
      data: {
        content: applied.rendered,
        from_user: 'prompt',
        extra: { prompt_id: prompt.id, prompt_title: prompt.title, variables: variables || {} }
      },
      context: {
        prompt_id: prompt.id,
        prompt_title: prompt.title,
        rendered: applied.rendered,
        missing_variables: applied.missing
      }
    });
    res.json({ success: true, data: { task_id: task.id, rendered: applied.rendered, missing: applied.missing } });
  })
);
