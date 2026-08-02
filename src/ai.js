import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * 统一 AI 调用层。
 * 从 settings 读取 ai_models 与 ai_routing，按用途选择模型并调用 OpenAI 兼容接口。
 * 所有调用可降级：未配置或失败时返回 null。
 */
const DEFAULT_TIMEOUT = 30000;

function getAiSettings(store) {
  const aiModels = store.getSetting('ai_models', { models: [] });
  const aiRouting = store.getSetting('ai_routing', {});
  return { models: aiModels.models || [], routing: aiRouting };
}

function pickModel({ models, routing }, purpose) {
  const name = routing?.[purpose] || routing?.default;
  if (!name) return null;
  return models.find((m) => m.name === name) || null;
}

function postJson(url, apiKey, body, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const client = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = client.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey ? `Bearer ${apiKey}` : '',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(chunks);
            const content = json.choices?.[0]?.message?.content || null;
            resolve({ ok: true, content });
          } catch {
            resolve({ ok: false, error: 'invalid json response' });
          }
        } else {
          resolve({ ok: false, error: `http ${res.statusCode}` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.write(data);
    req.end();
  });
}

export async function callAI(ctx, { purpose, messages, maxTokens = 500 }) {
  const { store, util } = ctx;
  const settings = getAiSettings(store);
  const model = pickModel(settings, purpose);
  if (!model) {
    store.log('info', 'ai', `AI 未配置 purpose=${purpose}，跳过 AI 调用`);
    return null;
  }
  if (!model.base_url || !model.model) {
    store.log('info', 'ai', `AI 模型 ${model.name} 缺少 base_url 或 model`);
    return null;
  }

  const url = `${model.base_url.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: model.model,
    messages,
    max_tokens: maxTokens,
    stream: false,
  };

  try {
    const resp = await postJson(url, model.api_key || '', body, DEFAULT_TIMEOUT);
    if (!resp.ok) {
      store.log('warn', 'ai', `AI 调用失败 purpose=${purpose}: ${resp.error}`);
      return null;
    }
    return { content: resp.content, model: model.name };
  } catch (err) {
    store.log('warn', 'ai', `AI 调用异常 purpose=${purpose}: ${err.message}`);
    return null;
  }
}

export async function isAiAvailable(ctx, purpose) {
  const { models, routing } = getAiSettings(ctx.store);
  const name = routing?.[purpose] || routing?.default;
  if (!name) return false;
  const m = models.find((x) => x.name === name);
  return !!(m && m.base_url && m.model);
}

export function listAiPurposes() {
  return ['compress', 'route', 'report', 'qa', 'default'];
}
