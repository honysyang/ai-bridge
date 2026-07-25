// ======== Embedding API 封装（v5.6.0）========
//
// 调用 OpenAI 兼容的 /v1/embeddings 接口生成向量。
// 不引入 openai SDK，直接使用 fetch，保持依赖最小化。

import { modelsConfig } from './models-config.js';

export interface EmbeddingConfig {
  provider: string;
  model: string;
  dimensions: number;
  batch_size: number;
}

export interface EmbeddingResult {
  embeddings: number[][];
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingError {
  error: string;
  provider?: string;
  model?: string;
}

/**
 * 获取当前有效的 Embedding 配置
 */
export function getEmbeddingConfig(): EmbeddingConfig | null {
  return modelsConfig.resolveEmbedding();
}

/**
 * 检查 Embedding 是否已配置且可用
 */
export function isEmbeddingAvailable(): boolean {
  return getEmbeddingConfig() !== null;
}

/**
 * 批量生成文本 embedding
 *
 * @param texts 文本数组
 * @returns 与输入顺序一致的 embedding 数组
 */
export async function createEmbeddings(texts: string[]): Promise<EmbeddingResult> {
  const cfg = getEmbeddingConfig();
  if (!cfg) {
    throw new Error('未配置 Embedding 模型，请在设置中配置 embedding_provider / embedding_model');
  }

  if (!texts.length) return { embeddings: [] };

  const apiKey = modelsConfig.getApiKey(cfg.provider);
  const baseUrl = modelsConfig.getBaseUrl(cfg.provider);
  if (!baseUrl) {
    throw new Error(`未找到 provider ${cfg.provider} 的 base URL`);
  }

  const url = `${baseUrl.replace(/\/$/, '')}/embeddings`;
  const body = {
    model: cfg.model,
    input: texts,
    encoding_format: 'float'
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Embedding API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    data: { index: number; embedding: number[] }[];
    usage?: { prompt_tokens: number; total_tokens: number };
  };

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Embedding API 返回格式异常：缺少 data 数组');
  }

  // 按 index 排序，保证与输入顺序一致
  const embeddings = data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);

  return {
    embeddings,
    usage: data.usage
  };
}

/**
 * 生成单条文本的 embedding
 */
export async function createEmbedding(text: string): Promise<number[]> {
  const result = await createEmbeddings([text]);
  if (!result.embeddings[0]) {
    throw new Error('Embedding API 未返回向量');
  }
  return result.embeddings[0];
}
