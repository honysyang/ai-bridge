/**
 * HTML 解析器（基于 cheerio）
 *
 * 负责：
 *   - 去除 script/style/nav/footer 等噪声标签
 *   - 提取 title / 正文 / 主要段落
 *   - URL 抓取后的正文清洗
 */

import * as cheerio from 'cheerio';

export interface ParsedHtml {
  title?: string;
  content: string;
  mime_type: string;
  char_count: number;
}

const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'nav',
  'footer',
  'header',
  'aside',
  '.sidebar',
  '.advertisement',
  '.ads',
  '.comments',
  '#comments',
  '[role="banner"]',
  '[role="complementary"]'
];

export function parseHtml(buffer: Buffer, _url?: string): ParsedHtml {
  const html = buffer.toString('utf-8');
  const $ = cheerio.load(html);

  // 移除噪声标签
  $(NOISE_SELECTORS.join(',')).remove();

  // 提取标题
  const title = $('title').text().trim() || $('h1').first().text().trim() || undefined;

  // 尝试找正文容器
  let bodyEl = $('article').first();
  if (!bodyEl.length) bodyEl = $('main').first();
  if (!bodyEl.length) bodyEl = $('.content').first();
  if (!bodyEl.length) bodyEl = $('#content').first();
  if (!bodyEl.length) bodyEl = $('body');

  // 提取段落、列表项、标题文本
  const parts: string[] = [];
  bodyEl.find('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 0) parts.push(text);
  });

  // 如果没找到段落，直接取 body 文本
  let content = parts.join('\n\n');
  if (!content) {
    content = bodyEl.text().replace(/\s+/g, ' ').trim();
  }

  // 简单去重空行
  content = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');

  return {
    title,
    content,
    mime_type: 'text/html',
    char_count: content.length
  };
}
