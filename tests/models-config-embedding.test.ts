import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { modelsConfig } from '../src/lib/models-config.js';

describe('models-config embedding', () => {
  let original: ReturnType<typeof modelsConfig.get>;

  beforeEach(() => {
    original = modelsConfig.get();
  });

  afterEach(() => {
    modelsConfig.update(original);
  });

  it('resolveEmbedding 在未配置时返回 null', () => {
    modelsConfig.update({
      embedding_provider: undefined,
      embedding_model: undefined
    });
    expect(modelsConfig.resolveEmbedding()).toBeNull();
  });

  it('resolveEmbedding 在配置有效时返回配置', () => {
    modelsConfig.update({
      enabled_providers: ['openai'],
      embedding_provider: 'openai',
      embedding_model: 'text-embedding-3-small',
      embedding_dimensions: 1536,
      embedding_batch_size: 16
    });
    const cfg = modelsConfig.resolveEmbedding();
    expect(cfg).not.toBeNull();
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.model).toBe('text-embedding-3-small');
    expect(cfg?.dimensions).toBe(1536);
    expect(cfg?.batch_size).toBe(16);
  });

  it('getEmbeddingDimensions 和 getEmbeddingBatchSize 有默认值', () => {
    modelsConfig.update({
      embedding_dimensions: undefined,
      embedding_batch_size: undefined
    });
    expect(modelsConfig.getEmbeddingDimensions()).toBe(1536);
    expect(modelsConfig.getEmbeddingBatchSize()).toBe(8);
  });
});
