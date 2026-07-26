// ======== AI 模型配置路由（v5.3.0 新增 / v5.4.2 扩展多 provider + 任务路由 / v5.5.4 支持自定义 provider）========
//
// GET    /api/models                 目录：providers + 当前 config + secrets 状态 + task_types
// GET    /api/models/status          provider 启用/配置状态摘要
// GET    /api/models/config          当前用户配置
// PATCH  /api/models/config          局部更新（默认 provider/model、启用列表、任务路由、自定义 providers、知识库模型）
// POST   /api/models/config/reset    恢复默认配置
// POST   /api/models/test            测试指定 provider/model 连通性
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
modelRouter.get(
  '/',
  asyncHandler((_req, res) => {
    res.json({ success: true, data: modelsConfig.catalog() });
  })
);

// 当前用户配置
modelRouter.get(
  '/config',
  asyncHandler((_req, res) => {
    res.json({ success: true, data: modelsConfig.get() });
  })
);

// 局部更新
modelRouter.patch(
  '/config',
  asyncHandler((req, res) => {
    const before = modelsConfig.get();
    const patch = req.body || {};
    // v5.5.6: 自定义 provider api_key 若是遮罩则保持原值
    if (Array.isArray(patch.custom_providers)) {
      patch.custom_providers = patch.custom_providers.map((p: any) => modelsConfig.normalizeCustomProviderInput(p));
    }
    const updated = modelsConfig.update(patch);
    // 详细日志：哪个字段变了
    const changes: string[] = [];
    if (before.default_provider !== updated.default_provider)
      changes.push(`provider ${before.default_provider}→${updated.default_provider}`);
    if (before.default_model !== updated.default_model)
      changes.push(`model ${before.default_model}→${updated.default_model}`);
    if (JSON.stringify(before.task_routing) !== JSON.stringify(updated.task_routing)) changes.push('task_routing');
    if (JSON.stringify(before.enabled_providers) !== JSON.stringify(updated.enabled_providers))
      changes.push('enabled_providers');
    if (JSON.stringify(before.custom_providers) !== JSON.stringify(updated.custom_providers))
      changes.push('custom_providers');
    if (before.kb_provider !== updated.kb_provider || before.kb_model !== updated.kb_model) changes.push('kb_model');
    if (
      before.embedding_provider !== updated.embedding_provider ||
      before.embedding_model !== updated.embedding_model ||
      before.embedding_dimensions !== updated.embedding_dimensions ||
      before.embedding_batch_size !== updated.embedding_batch_size
    ) {
      changes.push('embedding_model');
    }
    taskQueue.addLog('info', 'system', `[models] 配置已更新${changes.length ? ': ' + changes.join(', ') : ''}`);
    res.json({ success: true, data: updated, before });
  })
);

// 重置为默认
modelRouter.post(
  '/config/reset',
  asyncHandler((_req, res) => {
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
      custom_providers: [],
      embedding_provider: undefined,
      embedding_model: undefined,
      embedding_dimensions: 1536,
      embedding_batch_size: 8
    } as any);
    taskQueue.addLog('info', 'system', '[models] 已重置为默认配置');
    res.json({ success: true, data: fresh });
  })
);

// v6.0.1: 测试指定 provider/model 的连通性
modelRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const { provider: providerId, model: modelId } = req.body || {};
    if (!providerId) {
      return res.status(400).json({ success: false, error: '缺少 provider 参数' });
    }
    const provider = modelsConfig.allProviders().find((p) => p.id === providerId);
    if (!provider) {
      return res.status(400).json({ success: false, error: `未知 provider: ${providerId}` });
    }
    const model = modelId || provider.default_model;
    if (!provider.models.some((m) => m.id === model)) {
      return res.status(400).json({ success: false, error: `provider ${providerId} 不包含模型 ${model}` });
    }
    if (providerId === 'mock') {
      return res.json({
        success: true,
        data: { provider: providerId, model, status: 'ok', latency_ms: 0, note: 'Mock provider always returns OK' }
      });
    }
    const baseUrl = modelsConfig.getBaseUrl(providerId);
    const apiKey = modelsConfig.getApiKey(providerId);
    if (!baseUrl) {
      return res.status(400).json({ success: false, error: `未配置 ${providerId} 的 base URL` });
    }
    if (provider.env_key && !apiKey) {
      return res.status(400).json({ success: false, error: `未配置 ${providerId} 的 API Key` });
    }
    try {
      const started = Date.now();
      const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hi, reply "OK" only.' }],
          max_tokens: 5
        }),
        signal: AbortSignal.timeout(15000)
      });
      const latency_ms = Date.now() - started;
      if (!resp.ok) {
        const text = await resp.text();
        taskQueue.addLog('warn', 'system', `[models] 测试 ${providerId}/${model} 失败: HTTP ${resp.status}`);
        return res.json({
          success: true,
          data: {
            provider: providerId,
            model,
            status: 'error',
            latency_ms,
            error: `HTTP ${resp.status}: ${text.slice(0, 200)}`
          }
        });
      }
      const data = (await resp.json()) as any;
      const content = data?.choices?.[0]?.message?.content || '';
      taskQueue.addLog('info', 'system', `[models] 测试 ${providerId}/${model} 成功，耗时 ${latency_ms}ms`);
      res.json({
        success: true,
        data: { provider: providerId, model, status: 'ok', latency_ms, preview: content.slice(0, 100) }
      });
    } catch (e: any) {
      taskQueue.addLog('warn', 'system', `[models] 测试 ${providerId}/${model} 异常: ${e.message}`);
      res.json({
        success: true,
        data: { provider: providerId, model, status: 'error', latency_ms: 0, error: e.message }
      });
    }
  })
);

// v6.0.1: provider 配置状态摘要
modelRouter.get(
  '/status',
  asyncHandler((_req, res) => {
    const cfg = modelsConfig.get();
    const providers = modelsConfig.allProviders();
    const data = providers.map((p) => {
      const apiKey = modelsConfig.getApiKey(p.id);
      const baseUrl = modelsConfig.getBaseUrl(p.id);
      const configured = p.id === 'mock' || (!!baseUrl && (p.env_key ? !!apiKey : true));
      return {
        id: p.id,
        name: p.name,
        enabled: cfg.enabled_providers.includes(p.id),
        configured,
        has_custom_url: !!baseUrl && baseUrl !== p.base_url,
        base_url: baseUrl,
        default_model: p.default_model,
        api_key_masked: apiKey ? `${apiKey.slice(0, 6)}…(len=${apiKey.length})` : '',
        model_count: p.models.length
      };
    });
    res.json({ success: true, data });
  })
);

// v5.5.4: 解析知识库模型（必须放在 /resolve/:type 之前，避免被当作 task_type）
modelRouter.get(
  '/resolve/kb',
  asyncHandler((_req, res) => {
    const result = modelsConfig.resolveKB();
    if (!result) {
      return res.json({ success: true, data: null });
    }
    const p = modelsConfig.allProviders().find((p) => p.id === result.provider);
    res.json({
      success: true,
      data: {
        ...result,
        provider_name: p?.name || result.provider,
        model_name: p?.models.find((m) => m.id === result.model)?.name || result.model
      }
    });
  })
);

// v5.4.2: 解析 task_type 实际使用的 provider/model
modelRouter.get(
  '/resolve/:type',
  asyncHandler((req, res) => {
    const taskType = req.params.type;
    try {
      const result = modelsConfig.resolve(taskType as any);
      const provider = modelsConfig.allProviders().find((p) => p.id === result.provider);
      res.json({
        success: true,
        data: {
          task_type: taskType,
          ...result,
          provider_name: provider?.name || result.provider,
          model_name: provider?.models.find((m) => m.id === result.model)?.name || result.model
        }
      });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  })
);

// v5.4.2: 批量解析所有 task_type
modelRouter.get(
  '/resolve',
  asyncHandler((_req, res) => {
    const types = [
      'chat',
      'reply_message',
      'query_info',
      'analyze_data',
      'execute_command',
      'generate_content',
      'multi_step'
    ];
    const out = types.map((t) => {
      const r = modelsConfig.resolve(t as any);
      const p = modelsConfig.allProviders().find((p) => p.id === r.provider);
      return {
        task_type: t,
        ...r,
        provider_name: p?.name || r.provider,
        model_name: p?.models.find((m) => m.id === r.model)?.name || r.model
      };
    });
    res.json({ success: true, data: out });
  })
);
