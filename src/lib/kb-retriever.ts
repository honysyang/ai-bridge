// ======== KB RAG 检索器（v5.5.2 新增） ========
//
// 任务：在 KB 中按关键词检索与用户查询最相关的 Top-N 条目，
// 供 agent 在生成回复时作为上下文（"先查 KB 再答"）。
//
// 设计：
// - v5.5.2 阶段：使用简单 LIKE 模糊匹配（标题 / 正文 / 标签 命中加权）
// - v5.6.0 阶段：升级到 FTS5 全文索引 + 中文分词（更高准确率）
//
// 评分规则（v5.5.2 简单版）：
//   - 标题完全匹配（case-insensitive）：+10
//   - 标题包含关键词：+5
//   - 标签完全匹配：+4
//   - 正文包含关键词：+2
//   - 多关键词命中累加
//   - 最低阈值 0 才返回（避免噪声）
//
// 性能：26 个 KB 条目下，单次检索 < 5ms（内存遍历）；1000+ 条目考虑上 FTS5

import { kbStore } from '../kb-store.js';
import { KBItem, KBCategory } from '../kb-types.js';

export interface KBRetrievedItem {
  id: string;
  category_id: string;
  category_name: string;       // 分类名（方便直接展示）
  title: string;
  body_preview: string;        // body 前 200 字（避免 prompt 过长）
  body: string;                // 完整 body
  tags: string[];
  score: number;
  matched_keywords: string[];  // 命中的关键词（用于前端高亮）
}

export interface RetrievalOptions {
  topK?: number;               // 返回条数（默认 3）
  minScore?: number;           // 最低分（默认 1）
  maxBodyChars?: number;       // 单条 body 截断（默认 200）
  includeArchived?: boolean;   // 包含已归档（默认 false）
}

const DEFAULT_OPTS: Required<RetrievalOptions> = {
  topK: 3,
  minScore: 1,
  maxBodyChars: 200,
  includeArchived: false
};

/**
 * 中文友好的分词：按字符 + 简单标点切分
 * - 不引入 nodejieba / jieba 等重依赖
 * - 2-6 字子串 + 全字符串都作为关键词候选
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  const cleaned = text.toLowerCase().trim();
  const tokens = new Set<string>();

  // 1. 整体作为关键词（≥2 字才有效）
  if (cleaned.length >= 2) tokens.add(cleaned);

  // 2. 中英文分词
  // 英文：按空格和标点切
  const enMatches = cleaned.match(/[a-z0-9]+/gi);
  if (enMatches) enMatches.forEach(m => m.length >= 2 && tokens.add(m));

  // 中文：2-4 字滑窗
  const cnPart = cleaned.replace(/[a-z0-9\s\p{P}]/gu, '');
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= cnPart.length; i++) {
      tokens.add(cnPart.substring(i, i + n));
    }
  }

  return Array.from(tokens);
}

/**
 * 检索 KB 中与查询相关的条目
 */
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
    const tagsLower = item.tags.map(t => t.toLowerCase());

    let score = 0;
    const matched = new Set<string>();

    for (const kw of keywords) {
      // 标题完全匹配（高权重）
      if (titleLower === kw) {
        score += 10;
        matched.add(kw);
        continue;
      }
      // 标题包含
      if (titleLower.includes(kw)) {
        score += 5;
        matched.add(kw);
      }
      // 标签匹配
      if (tagsLower.includes(kw)) {
        score += 4;
        matched.add(kw);
      }
      // 正文包含
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
      body_preview: item.body.length > o.maxBodyChars
        ? item.body.substring(0, o.maxBodyChars) + '…'
        : item.body,
      body: item.body,
      tags: item.tags,
      score,
      matched_keywords: Array.from(matched)
    });
  }

  // 排序：score desc → 创建时间 desc
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, o.topK);
}

/**
 * 把检索结果格式化为 prompt 友好的文本
 * 注入位置：task context，agent 在生成回复前看到
 */
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

/**
 * 一站式：检索 + 格式化
 * 用法：const ctx = retrieveAndFormat(query); → 注入 task.context.kb_context
 */
export function retrieveAndFormat(query: string, opts: RetrievalOptions = {}): {
  context: string;
  items: KBRetrievedItem[];
  hit_count: number;
} {
  const items = searchKB(query, opts);
  return {
    context: formatKBContextForPrompt(items),
    items,
    hit_count: items.length
  };
}
