import { describe, it, expect } from 'vitest';
import { chunkRepoFiles } from '../src/lib/code-repo-chunking.js';
import { makeRepoId } from '../src/lib/git-clone.js';

describe('code-repo-chunking', () => {
  it('should chunk files with source_path', () => {
    const files = [
      { path: 'src/index.ts', content: 'function a() {}\nfunction b() {}\n' },
      { path: 'README.md', content: '# hello\nworld\n' }
    ];
    const chunks = chunkRepoFiles(files, { maxChunkSize: 200, overlap: 0, maxFiles: 10 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].source_path).toBe('src/index.ts');
    expect(typeof chunks[0].chunk_index).toBe('number');
    expect(chunks[0].token_count).toBeGreaterThanOrEqual(0);
  });

  it('should respect maxFiles', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `f${i}.ts`,
      content: `function fn${i}() {}`
    }));
    const chunks = chunkRepoFiles(files, { maxFiles: 5 });
    // 只处理前 5 个文件
    const paths = new Set(chunks.map((c) => c.source_path));
    expect(paths.size).toBeLessThanOrEqual(5);
  });
});

describe('makeRepoId', () => {
  it('should generate deterministic repo id', () => {
    const id1 = makeRepoId('https://gitee.com/foo/bar.git');
    const id2 = makeRepoId('https://gitee.com/foo/bar.git');
    expect(id1).toMatch(/^repo-[a-zA-Z0-9]+$/);
    expect(id1).toBe(id2);
  });
});
