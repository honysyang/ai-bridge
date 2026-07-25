/**
 * Office 文档解析器（基于 mammoth）
 * 支持 .docx / .doc（现代格式）
 */

import mammoth from 'mammoth';

export interface ParsedOffice {
  title?: string;
  content: string;
  mime_type: string;
  char_count: number;
}

export async function parseDocx(buffer: Buffer, fileName?: string): Promise<ParsedOffice> {
  const result = await mammoth.extractRawText({ buffer });
  const content = result.value
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: fileName ? fileName.replace(/\.(docx|doc)$/i, '') : undefined,
    content,
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    char_count: content.length
  };
}
