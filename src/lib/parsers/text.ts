/**
 * 纯文本 / Markdown 解析器
 *
 * Markdown 本身就是一种易读文本，Phase 2 先保留原始格式，
 * 后续可接入 markdown-it 渲染后再提取纯文本。
 */

export interface ParsedText {
  title?: string;
  content: string;
  mime_type: string;
  char_count: number;
}

export function parseText(buffer: Buffer, fileName?: string): ParsedText {
  const content = buffer.toString('utf-8').replace(/\r\n/g, '\n').trim();
  const title = fileName ? fileName.replace(/\.(md|txt)$/i, '') : undefined;
  return {
    title,
    content,
    mime_type: 'text/plain',
    char_count: content.length
  };
}

export function parseMarkdown(buffer: Buffer, fileName?: string): ParsedText {
  const parsed = parseText(buffer, fileName);
  parsed.mime_type = 'text/markdown';
  return parsed;
}
