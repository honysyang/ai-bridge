// ======== KB RAG 检索器（v5.6.0 升级）========
//
// 任务：在 KB 中按用户查询检索最相关的 Top-N 条目/片段，
// 供 agent 在生成回复时作为上下文（"先查 KB 再答"）。
//
// v5.6.0 升级：
//   - 新增向量检索（基于远程 Embedding API）
//   - 保留关键词检索作为 fallback
//   - 支持 mode: 'keyword' | 'vector' | 'hybrid'
//   - 返回结果包含命中片段（chunk）预览

import { kbStore } from '../kb-store.js';
import { kbChunkStore } from '../kb-chunk-store.js';
import { KBCategory } from '../kb-types.js';
import { createEmbedding, getEmbeddingConfig } from './embedding.js';

export interface KBRetrievedItem {
  id: string;
  category_id: string;
  category_name: string;
  title: string;
  body_preview: string; // 命中片段或 body 前 N 字
  body: string; // 完整 body
  tags: string[];
  score: number;
  matched_keywords: string[];
  chunk_source_path?: string;
}

export interface RetrievalOptions {
  topK?: number; // 返回条数（默认 3）
  minScore?: number; // 最低分（默认 1）
  maxBodyChars?: number; // 单条 body 截断（默认 200）
  includeArchived?: boolean; // 包含已归档（默认 false）
  mode?: 'keyword' | 'vector' | 'hybrid'; // 检索模式（默认 hybrid）
}

const DEFAULT_OPTS: Required<RetrievalOptions> = {
  topK: 3,
  minScore: 1,
  maxBodyChars: 200,
  includeArchived: false,
  mode: 'hybrid'
};

// ======== 关键词检索（v5.5.2 保留） ========

function tokenize(text: string): string[] {
  if (!text) return [];
  const cleaned = text.toLowerCase().trim();
  const tokens = new Set<string>();

  if (cleaned.length >= 2) tokens.add(cleaned);

  const enMatches = cleaned.match(/[a-z0-9]+/gi);
  if (enMatches) enMatches.forEach((m) => m.length >= 2 && tokens.add(m));

  const cnPart = cleaned.replace(/[a-z0-9\s\p{P}]/gu, '');
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= cnPart.length; i++) {
      tokens.add(cnPart.substring(i, i + n));
    }
  }

  return Array.from(tokens);
}

export function searchKB(query: string, opts: RetrievalOptions = {}): KBRetrievedItem[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  const keywords = tokenize(query);
  if (keywords.length === 0) return [];

  const list = kbStore.list();
  const catMap = new Map<string, KBCategory>();
  for (const c of list.categories) catMap.set(c.id, c);

  const scored: KBRetrievedItem[] = [];
  for (const item of list.items) {
    if (!o.includeArchived && item.archived) continue;

    const titleLower = item.title.toLowerCase();
    const bodyLower = item.body.toLowerCase();
    const tagsLower = item.tags.map((t) => t.toLowerCase());

    let score = 0;
    const matched = new Set<string>();

    for (const kw of keywords) {
      if (titleLower === kw) {
        score += 10;
        matched.add(kw);
        continue;
      }
      if (titleLower.includes(kw)) {
        score += 5;
        matched.add(kw);
      }
      if (tagsLower.includes(kw)) {
        score += 4;
        matched.add(kw);
      }
      if (bodyLower.includes(kw)) {
        score += 2;
        matched.add(kw);
      }
    }

    if (score < o.minScore) continue;

    const cat = catMap.get(item.category_id);
    scored.push({
      id: item.id,
      category_id: item.category_id,
      category_name: cat?.name || '未分类',
      title: item.title,
      body_preview: item.body.length > o.maxBodyChars ? item.body.substring(0, o.maxBodyChars) + '…' : item.body,
      body: item.body,
      tags: item.tags,
      score,
      matched_keywords: Array.from(matched)
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, o.topK);
}

// ======== 向量检索 ========

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function searchKBVector(query: string, opts: RetrievalOptions = {}): Promise<KBRetrievedItem[]> {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!getEmbeddingConfig()) return [];

  let queryEmbedding: number[];
  try {
    queryEmbedding = await createEmbedding(query);
  } catch (e) {
    console.error('[kb-retriever] embedding failed:', e);
    return [];
  }

  const allChunks = kbChunkStore.list();
  const scored = [];
  for (const chunk of allChunks) {
    if (!chunk.embedding || chunk.embedding.length === 0) continue;
    const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
    if (sim < o.minScore / 100) continue; // 向量分数范围 [0,1]，minScore 默认 1 相当于 0.01
    scored.push({ chunk, sim });
  }

  scored.sort((a, b) => b.sim - a.sim);
  const topChunks = scored.slice(0, o.topK * 2);

  // 按 item 聚合，取最高相似度
  const itemBest = new Map<string, { sim: number; chunk: (typeof topChunks)[0]['chunk'] }>();
  for (const s of topChunks) {
    const existing = itemBest.get(s.chunk.item_id);
    if (!existing || existing.sim < s.sim) {
      itemBest.set(s.chunk.item_id, { sim: s.sim, chunk: s.chunk });
    }
  }

  const list = kbStore.list();
  const catMap = new Map<string, KBCategory>();
  for (const c of list.categories) catMap.set(c.id, c);

  const results: KBRetrievedItem[] = [];
  for (const [itemId, { sim, chunk }] of Array.from(itemBest.entries()).sort((a, b) => b[1].sim - a[1].sim)) {
    const item = kbStore.getItem(itemId);
    if (!item || (!o.includeArchived && item.archived)) continue;
    const cat = catMap.get(item.category_id);
    const preview = chunk.content;
    results.push({
      id: item.id,
      category_id: item.category_id,
      category_name: cat?.name || '未分类',
      title: item.title,
      body_preview: preview.length > o.maxBodyChars ? preview.substring(0, o.maxBodyChars) + '…' : preview,
      body: item.body,
      tags: item.tags,
      score: Math.round(sim * 100),
      matched_keywords: [],
      chunk_source_path: chunk.source_path
    });
  }

  return results.slice(0, o.topK);
}

// ======== 混合检索 ========

export async function searchKBAsync(query: string, opts: RetrievalOptions = {}): Promise<KBRetrievedItem[]> {
  const o = { ...DEFAULT_OPTS, ...opts };

  if (o.mode === 'keyword') {
    return searchKB(query, opts);
  }

  if (o.mode === 'vector') {
    return searchKBVector(query, opts);
  }

  // hybrid: 合并关键词和向量结果，共同命中的加权
  const [keywordItems, vectorItems] = await Promise.all([
    Promise.resolve(searchKB(query, { ...opts, topK: o.topK * 2 })),
    searchKBVector(query, { ...opts, topK: o.topK * 2 })
  ]);

  const map = new Map<string, KBRetrievedItem>();

  for (const it of keywordItems) {
    map.set(it.id, { ...it, score: it.score * 10 }); // 关键词分数放大到与向量同量级
  }

  for (const it of vectorItems) {
    const existing = map.get(it.id);
    if (existing) {
      // 共同命中：加权叠加
      existing.score = Math.round(existing.score * 0.6 + it.score * 1.4);
      if (it.chunk_source_path) existing.chunk_source_path = it.chunk_source_path;
      // 如果向量命中具体片段，用片段预览替换 body 预览
      if (it.body_preview && it.body_preview !== existing.body_preview) {
        existing.body_preview = it.body_preview;
      }
    } else {
      map.set(it.id, { ...it });
    }
  }

  const results = Array.from(map.values())
    .filter((it) => it.score >= o.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, o.topK);

  return results;
}

// ======== 格式化与便捷函数 ========

export function formatKBContextForPrompt(items: KBRetrievedItem[]): string {
  if (items.length === 0) return '';
  const lines: string[] = ['【相关知识】'];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const tagStr = it.tags.length > 0 ? ` [${it.tags.join('/')}]` : '';
    lines.push(`${i + 1}. [${it.category_name}/${it.title}]${tagStr} (匹配度: ${it.score})`);
    lines.push(`   ${it.body_preview}`);
  }
  return lines.join('\n');
}

export async function retrieveAndFormat(
  query: string,
  opts: RetrievalOptions = {}
): Promise<{
  context: string;
  items: KBRetrievedItem[];
  hit_count: number;
}> {
  const items = await searchKBAsync(query, opts);
  return {
    context: formatKBContextForPrompt(items),
    items,
    hit_count: items.length
  };
}
