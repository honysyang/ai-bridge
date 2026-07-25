/**
 * 文档解析器统一入口
 */

export { parseText, parseMarkdown } from './text.js';
export { parseHtml } from './html.js';
export { parsePdf } from './pdf.js';
export { parseDocx } from './office.js';

export interface ParsedDocument {
  title?: string;
  content: string;
  mime_type: string;
  char_count: number;
  page_count?: number;
  author?: string;
}

import { parseText, parseMarkdown } from './text.js';
import { parseHtml } from './html.js';
import { parsePdf } from './pdf.js';
import { parseDocx } from './office.js';

export async function parseDocument(buffer: Buffer, mimeType: string, fileName?: string): Promise<ParsedDocument> {
  switch (mimeType) {
    case 'text/plain':
    case 'text/text':
      return parseText(buffer, fileName);
    case 'text/markdown':
    case 'text/x-markdown':
      return parseMarkdown(buffer, fileName);
    case 'text/html':
    case 'application/xhtml+xml':
      return parseHtml(buffer);
    case 'application/pdf':
      return parsePdf(buffer);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      return parseDocx(buffer, fileName);
    default:
      // 未知类型按纯文本尝试
      if (fileName && /\.md$/i.test(fileName)) return parseMarkdown(buffer, fileName);
      if (fileName && /\.(html|htm)$/i.test(fileName)) return parseHtml(buffer);
      if (fileName && /\.pdf$/i.test(fileName)) return parsePdf(buffer);
      if (fileName && /\.(docx|doc)$/i.test(fileName)) return parseDocx(buffer, fileName);
      return parseText(buffer, fileName);
  }
}
