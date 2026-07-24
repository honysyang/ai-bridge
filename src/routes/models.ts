// ======== AI 模型配置路由（v5.3.0 新增 / v5.4.2 扩展多 provider + 任务路由）========
//
// GET    /api/models                 目录：providers + 当前 config + secrets 状态 + task_types
// GET    /api/models/config          当前用户配置
// PATCH  /api/models/config          局部更新（默认 provider/model、启用列表、任务路由）
// POST   /api/models/config/reset    恢复默认配置
// GET    /api/models/resolve/:type   解析 task_type 实际使用的 provider/model
//
// 注意：API key 等敏感字段不在这里读写，统一在 ~/.config/agent-canvas/secrets.env。

import { Router } from 'express';
import { modelsConfig, MODEL_PROVIDERS } from '../lib/models-config.js';
import { taskQueue } from '../task-queue.js';
import { asyncHandler } from '../middleware/error.js';

export const modelRouter = Router();

// 目录（前端首选接口，符合 project_memory 「Model configuration panel must fetch data from /api/models endpoint」）
modelRouter.get('/', asyncHandler((_req, res) => {
  res.json({ success: true, data: modelsConfig.catalog() });
}));

// 当前用户配置
modelRouter.get('/config', asyncHandler((_req, res) => {
  res.json({ success: true, data: modelsConfig.get() });
}));

// 局部更新
modelRouter.patch('/config', asyncHandler((req, res) => {
  const before = modelsConfig.get();
  const updated = modelsConfig.update(req.body || {});
  // 详细日志：哪个字段变了
  const changes: string[] = [];
  if (before.default_provider !== updated.default_provider) changes.push(`provider ${before.default_provider}→${updated.default_provider}`);
  if (before.default_model !== updated.default_model) changes.push(`model ${before.default_model}→${updated.default_model}`);
  if (JSON.stringify(before.task_routing) !== JSON.stringify(updated.task_routing)) changes.push('task_routing');
  if (JSON.stringify(before.enabled_providers) !== JSON.stringify(updated.enabled_providers)) changes.push('enabled_providers');
  taskQueue.addLog('info', 'system', `[models] 配置已更新${changes.length ? ': ' + changes.join(', ') : ''}`);
  res.json({ success: true, data: updated, before });
}));

// 重置为默认
modelRouter.post('/config/reset', asyncHandler((_req, res) => {
  const fresh = modelsConfig.update({
    default_provider: 'deepseek',
    default_model: 'deepseek-chat',
    enabled_providers: ['deepseek', 'mock'],
    provider_overrides: {},
    task_routing: {
      multi_step: { provider: 'deepseek', model: 'deepseek-reasoner' },
      analyze_data: { provider: 'deepseek', model: 'deepseek-reasoner' },
      generate_content: { provider: 'deepseek', model: 'deepseek-chat' }
    },
    routing_strategy: 'fixed'
  } as any);
  taskQueue.addLog('info', 'system', '[models] 已重置为默认配置');
  res.json({ success: true, data: fresh });
}));

// v5.4.2: 解析 task_type 实际使用的 provider/model
modelRouter.get('/resolve/:type', asyncHandler((req, res) => {
  const taskType = req.params.type;
  try {
    const result = modelsConfig.resolve(taskType as any);
    const provider = MODEL_PROVIDERS.find(p => p.id === result.provider);
    res.json({
      success: true,
      data: {
        task_type: taskType,
        ...result,
        provider_name: provider?.name || result.provider,
        model_name: provider?.models.find(m => m.id === result.model)?.name || result.model
      }
    });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

// v5.4.2: 批量解析所有 task_type
modelRouter.get('/resolve', asyncHandler((_req, res) => {
  const types = ['chat', 'reply_message', 'query_info', 'analyze_data', 'execute_command', 'generate_content', 'multi_step'];
  const out = types.map(t => {
    const r = modelsConfig.resolve(t as any);
    const p = MODEL_PROVIDERS.find(p => p.id === r.provider);
    return {
      task_type: t,
      ...r,
      provider_name: p?.name || r.provider,
      model_name: p?.models.find(m => m.id === r.model)?.name || r.model
    };
  });
  res.json({ success: true, data: out });
}));
