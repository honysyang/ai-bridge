// ======== AI 模型配置路由（v5.3.0 新增 / v5.4.2 扩展多 provider + 任务路由 / v5.5.4 支持自定义 provider）========
//
// GET    /api/models                 目录：providers + 当前 config + secrets 状态 + task_types
// GET    /api/models/config          当前用户配置
// PATCH  /api/models/config          局部更新（默认 provider/model、启用列表、任务路由、自定义 providers、知识库模型）
// POST   /api/models/config/reset    恢复默认配置
// GET    /api/models/resolve/:type   解析 task_type 实际使用的 provider/model
// GET    /api/models/resolve/kb     解析知识库模型
//
// 注意：内置 Provider 的 API key 仍从 ~/.config/agent-canvas/secrets.env 读取（只读遮罩）；
//       自定义 provider 的 API key 通过 PATCH /config 保存到 data/models-config.json（chmod 600）。

import { Router } from 'express';
import { modelsConfig } from '../lib/models-config.js';
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
  if (JSON.stringify(before.custom_providers) !== JSON.stringify(updated.custom_providers)) changes.push('custom_providers');
  if (before.kb_provider !== updated.kb_provider || before.kb_model !== updated.kb_model) changes.push('kb_model');
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
    routing_strategy: 'fixed',
    custom_providers: []
  } as any);
  taskQueue.addLog('info', 'system', '[models] 已重置为默认配置');
  res.json({ success: true, data: fresh });
}));

// v5.5.4: 解析知识库模型（必须放在 /resolve/:type 之前，避免被当作 task_type）
modelRouter.get('/resolve/kb', asyncHandler((_req, res) => {
  const result = modelsConfig.resolveKB();
  if (!result) {
    return res.json({ success: true, data: null });
  }
  const p = modelsConfig.allProviders().find(p => p.id === result.provider);
  res.json({
    success: true,
    data: {
      ...result,
      provider_name: p?.name || result.provider,
      model_name: p?.models.find(m => m.id === result.model)?.name || result.model
    }
  });
}));

// v5.4.2: 解析 task_type 实际使用的 provider/model
modelRouter.get('/resolve/:type', asyncHandler((req, res) => {
  const taskType = req.params.type;
  try {
    const result = modelsConfig.resolve(taskType as any);
    const provider = modelsConfig.allProviders().find(p => p.id === result.provider);
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
    const p = modelsConfig.allProviders().find(p => p.id === r.provider);
    return {
      task_type: t,
      ...r,
      provider_name: p?.name || r.provider,
      model_name: p?.models.find(m => m.id === r.model)?.name || r.model
    };
  });
  res.json({ success: true, data: out });
}));

// v5.5.4: 解析知识库模型
modelRouter.get('/resolve/kb', asyncHandler((_req, res) => {
  const result = modelsConfig.resolveKB();
  if (!result) {
    return res.json({ success: true, data: null });
  }
  const p = modelsConfig.allProviders().find(p => p.id === result.provider);
  res.json({
    success: true,
    data: {
      ...result,
      provider_name: p?.name || result.provider,
      model_name: p?.models.find(m => m.id === result.model)?.name || result.model
    }
  });
}));
