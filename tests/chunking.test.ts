import { describe, it, expect } from 'vitest';
import { chunkText, chunkCode, estimateTokens } from '../src/lib/chunking.js';

describe('chunking', () => {
  it('短文本应返回单个 chunk', () => {
    const text = '这是一个短文本。';
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe(text);
    expect((chunks[0].token_count ?? 0) > 0).toBe(true);
  });

  it('长段落应按句子/窗口切分', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `这是第${i + 1}句测试句子，用于验证长文本切分逻辑。`);
    const text = sentences.join('');
    const chunks = chunkText(text, { maxChunkSize: 100, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(100);
    }
  });

  it('代码应按函数边界切分', () => {
    const code = `
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}
`;
    const chunks = chunkCode(code, 'math.js', { maxChunkSize: 500 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].source_path).toBe('math.js');
  });

  it('token 估算应返回正数', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('你好世界')).toBeGreaterThan(0);
  });
});
