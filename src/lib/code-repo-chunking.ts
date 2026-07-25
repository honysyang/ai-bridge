/**
 * 代码仓库切片（v5.6.0）
 *
 * 将仓库文本文件统一切成 TextChunk，保留 source_path、token_count 等元数据。
 */

import { chunkCode, estimateTokens, TextChunk } from './chunking.js';

export interface RepoFileChunk extends TextChunk {
  chunk_index: number;
  source_path: string;
  token_count: number;
}

export interface RepoChunkOptions {
  maxChunkSize?: number;
  overlap?: number;
  maxFiles?: number;
  maxSizePerFile?: number;
}

const DEFAULT_OPTS: Required<RepoChunkOptions> = {
  maxChunkSize: 1200,
  overlap: 120,
  maxFiles: 1000,
  maxSizePerFile: 500 * 1024
};

export function chunkRepoFiles(
  files: { path: string; content: string }[],
  opts: RepoChunkOptions = {}
): RepoFileChunk[] {
  const { maxChunkSize, overlap, maxFiles } = { ...DEFAULT_OPTS, ...opts };
  const chunks: RepoFileChunk[] = [];
  let globalIndex = 0;

  for (const file of files.slice(0, maxFiles)) {
    const fileChunks = chunkCode(file.content, file.path, {
      maxChunkSize,
      overlap
    });
    for (const c of fileChunks) {
      chunks.push({
        chunk_index: globalIndex++,
        content: c.content,
        source_path: c.source_path || file.path,
        token_count: c.token_count ?? estimateTokens(c.content)
      });
    }
  }

  return chunks;
}
