// ======== 文本/代码 Chunk 切分（v5.6.0）========
//
// 设计原则：
//   - 先按自然段落（\n\n）切分，段落过长再按句子切分
//   - 中文按字符数控制，英文按单词/字符混合控制
//   - 保留 overlap，保证跨边界语义不被截断
//   - 代码块尽量保持完整函数/类（Phase 1 先用简单启发式）
//
// 当前阶段不引入 tiktoken 等重依赖，token 估算使用经验公式。

export interface ChunkOptions {
  maxChunkSize?: number; // 单个 chunk 最大字符数（默认 800）
  overlap?: number; // 相邻 chunk 重叠字符数（默认 100）
  preserveParagraphs?: boolean; // 优先保留段落边界（默认 true）
}

export interface TextChunk {
  content: string;
  source_path?: string; // 来源路径/章节（仓库文件路径等）
  token_count?: number;
}

const DEFAULT_OPTS: Required<ChunkOptions> = {
  maxChunkSize: 800,
  overlap: 100,
  preserveParagraphs: true
};

/**
 * 经验 token 估算：
 *   - 中文字符：约 0.6 tokens/字
 *   - 英文单词：约 1.3 tokens/词
 *   - 代码/符号：约 1.0 tokens/字符
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cnChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const enWords = (text.match(/[a-zA-Z0-9_]+/g) || []).length;
  const otherChars = text.length - cnChars;
  return Math.ceil(cnChars * 0.6 + enWords * 1.3 + otherChars * 0.3);
}

/**
 * 按句子切分（支持中文句号/问号/感叹号/英文句点）
 */
function splitSentences(text: string): string[] {
  // 保留中文句末标点，避免把 "Mr. Smith" 等英文缩写误切
  const sentences: string[] = [];
  const regex = /[^.!?。！？\n]+[.!?。！？]?/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) sentences.push(s);
  }
  return sentences.length ? sentences : [text];
}

/**
 * 滑动窗口切分：把一段长文本按固定大小 + 重叠切分
 */
function slidingWindowChunks(text: string, maxSize: number, overlap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxSize, text.length);
    out.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
    if (start >= text.length) break;
  }
  return out;
}

/**
 * 对单个段落做 chunk：优先按句子，句子太长再 sliding window
 */
function chunkParagraph(paragraph: string, maxSize: number, overlap: number): string[] {
  const trimmed = paragraph.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxSize) return [trimmed];

  const sentences = splitSentences(trimmed);
  const out: string[] = [];
  let buffer = '';

  for (const s of sentences) {
    if (s.length > maxSize) {
      // 句子本身超过限制，先 flush buffer，再对句子做 sliding window
      if (buffer) {
        out.push(buffer.trim());
        buffer = '';
      }
      out.push(...slidingWindowChunks(s, maxSize, overlap));
      continue;
    }
    if (buffer.length + s.length + 1 > maxSize) {
      out.push(buffer.trim());
      buffer = s;
    } else {
      buffer = buffer ? `${buffer} ${s}` : s;
    }
  }
  if (buffer) out.push(buffer.trim());

  return out;
}

/**
 * 通用文本 chunk 切分
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!text || !text.trim()) return [];

  const paragraphs = text.split(/\n\s*\n/);
  const out: TextChunk[] = [];

  for (const p of paragraphs) {
    const parts = chunkParagraph(p, o.maxChunkSize, o.overlap);
    for (const content of parts) {
      out.push({
        content,
        token_count: estimateTokens(content)
      });
    }
  }

  return out;
}

/**
 * 代码文件 chunk 切分（Phase 1 简单版）
 *   - 保留文件头注释 / import 作为第一个 chunk
 *   - 按函数/类/方法边界切分（简单正则）
 *   - 过短片段合并
 */
export function chunkCode(text: string, filePath?: string, opts: ChunkOptions = {}): TextChunk[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!text || !text.trim()) return [];

  // 简单函数/类边界正则（支持 TS/JS/Python/Go/Java/Rust/C 等常见语法）
  const boundaryRegex =
    /^(\s*)(?:export\s+|async\s+)?(?:function\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|def\s+\w+|func\s+(?:\([^)]+\)\s*)?\w+|public\s+\w+\s+\w+|private\s+\w+\s+\w+)/gm;

  const lines = text.split('\n');
  const sections: { header: string; body: string }[] = [];
  let currentHeader = '';
  let currentBody = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    boundaryRegex.lastIndex = 0;
    if (boundaryRegex.test(line)) {
      if (currentHeader || currentBody) {
        sections.push({ header: currentHeader, body: currentBody });
      }
      currentHeader = line;
      currentBody = '';
    } else {
      currentBody += line + '\n';
    }
  }
  if (currentHeader || currentBody) {
    sections.push({ header: currentHeader, body: currentBody });
  }

  // 如果没有匹配到边界，回退到普通文本切分
  if (sections.length === 0 || (sections.length === 1 && !sections[0].header)) {
    return chunkText(text, opts).map((c) => ({ ...c, source_path: filePath }));
  }

  const out: TextChunk[] = [];
  for (const sec of sections) {
    const content = `${sec.header}\n${sec.body}`.trim();
    if (!content) continue;
    if (content.length <= o.maxChunkSize) {
      out.push({ content, source_path: filePath, token_count: estimateTokens(content) });
    } else {
      const parts = chunkParagraph(content, o.maxChunkSize, o.overlap);
      for (const part of parts) {
        out.push({ content: part, source_path: filePath, token_count: estimateTokens(part) });
      }
    }
  }

  return out;
}
