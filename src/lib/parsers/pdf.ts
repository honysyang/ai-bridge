/**
 * PDF 解析器（基于 pdf-parse v2）
 */

import { PDFParse } from 'pdf-parse';

export interface ParsedPdf {
  title?: string;
  content: string;
  mime_type: string;
  char_count: number;
  page_count?: number;
  author?: string;
}

export async function parsePdf(buffer: Buffer): Promise<ParsedPdf> {
  const parser = new PDFParse({ data: buffer });
  try {
    const [textResult, infoResult] = await Promise.all([parser.getText(), parser.getInfo()]);
    const content = (textResult.text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      title: infoResult.info?.Title || undefined,
      content,
      mime_type: 'application/pdf',
      char_count: content.length,
      page_count: infoResult.total || infoResult.pages.length,
      author: infoResult.info?.Author || undefined
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
