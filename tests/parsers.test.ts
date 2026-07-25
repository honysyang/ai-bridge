import { describe, it, expect } from 'vitest';
import { parseText, parseMarkdown, parseHtml } from '../src/lib/parsers/index.js';

describe('parsers', () => {
  it('parseText 提取纯文本', () => {
    const res = parseText(Buffer.from('Hello world'));
    expect(res.content).toBe('Hello world');
    expect(res.mime_type).toBe('text/plain');
  });

  it('parseMarkdown 识别 markdown 类型', () => {
    const res = parseMarkdown(Buffer.from('# Title\n\nbody'), 'doc.md');
    expect(res.content).toBe('# Title\n\nbody');
    expect(res.mime_type).toBe('text/markdown');
    expect(res.title).toBe('doc');
  });

  it('parseHtml 去除 script/style 并提取正文', () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <nav>nav content</nav>
          <script>alert(1)</script>
          <style>.x{}</style>
          <article>
            <h1>Main Title</h1>
            <p>First paragraph.</p>
            <p>Second paragraph.</p>
          </article>
        </body>
      </html>
    `;
    const res = parseHtml(Buffer.from(html));
    expect(res.title).toBe('Test Page');
    expect(res.content).toContain('Main Title');
    expect(res.content).toContain('First paragraph');
    expect(res.content).not.toContain('alert');
    expect(res.content).not.toContain('nav content');
  });
});
