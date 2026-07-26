/**
 * KB Ingestion 管道（v5.6.0）
 *
 * 统一处理多种来源：
 *   - 文件上传（PDF / HTML / Markdown / TXT / DOCX）
 *   - URL 抓取
 *   - 聊天消息（已在 routes/kb.ts 中直接处理）
 *
 * 流程：
 *   来源识别 → 内容抓取/解析 → 文本清洗 → chunk 切分 → embedding 生成 → 保存
 */

import { kbStore } from '../kb-store.js';
import { parseDocument, ParsedDocument } from './parsers/index.js';
import { parseHtml } from './parsers/html.js';
import { KBContentType, KBSourceMetadata, KBItem } from '../kb-types.js';
import { cloneOrUpdateRepo, readRepoTextFiles, makeRepoId, RepoMeta } from './git-clone.js';
import { chunkRepoFiles } from './code-repo-chunking.js';

export interface IngestFileResult {
  item_id: string;
  title: string;
  chunks: number;
  status: 'indexed' | 'failed' | 'no_embedding';
  mime_type: string;
  char_count: number;
}

export interface IngestUrlResult extends IngestFileResult {
  url: string;
}

export interface IngestRepoResult extends IngestFileResult {
  repo_url: string;
  branch: string;
  commit?: string;
  file_count: number;
}

export interface IngestMessageResult {
  item_id: string;
  title: string;
  status: 'indexed' | 'failed' | 'no_embedding';
}

function mapIndexStatus(status?: KBItem['index_status'] | null): IngestFileResult['status'] {
  if (status === 'indexed') return 'indexed';
  if (status === 'failed') return 'failed';
  return 'no_embedding';
}

/**
 * 根据文件名推断 content_type
 */
function inferContentType(mimeType: string, fileName?: string): KBContentType {
  if (mimeType === 'application/pdf' || fileName?.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (mimeType === 'text/html' || fileName?.toLowerCase().endsWith('.html')) return 'html';
  if (mimeType === 'text/markdown' || fileName?.toLowerCase().endsWith('.md')) return 'markdown';
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileName?.toLowerCase().endsWith('.docx') ||
    fileName?.toLowerCase().endsWith('.doc')
  )
    return 'text';
  return 'text';
}

/**
 * 将解析后的文档保存到知识库并建立索引
 */
async function saveDocumentToKB(
  parsed: ParsedDocument,
  categoryId: string,
  tags: string[],
  source_type: 'file' | 'url',
  source_url?: string,
  fileName?: string,
  scenarioId?: string
): Promise<IngestFileResult> {
  const title = parsed.title || fileName || '未命名文档';
  const contentType = inferContentType(parsed.mime_type, fileName);
  const metadata: KBSourceMetadata = {
    mime_type: parsed.mime_type,
    file_name: fileName,
    ...(parsed.page_count !== undefined ? { page_count: parsed.page_count } : {}),
    ...(parsed.author ? { author: parsed.author } : {}),
    last_fetched_at: Date.now()
  };

  const item = kbStore.createItem(categoryId, title.slice(0, 64), parsed.content.slice(0, 4000), tags, {
    scenario_id: scenarioId,
    source_type,
    source_url,
    source_metadata: metadata,
    content_type: contentType
  });

  if (!item) {
    throw new Error('创建 KBItem 失败，分类可能不存在');
  }

  const result = await kbStore.reindexItem(item.id);
  return {
    item_id: item.id,
    title: item.title,
    chunks: result?.chunks || 0,
    status: mapIndexStatus(result?.status),
    mime_type: parsed.mime_type,
    char_count: parsed.char_count
  };
}

/**
 * 上传文件 ingestion
 */
export async function ingestFile(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  categoryId: string = '__orphan__',
  tags: string[] = [],
  scenarioId?: string
): Promise<IngestFileResult> {
  const parsed = await parseDocument(buffer, mimeType, fileName);
  return saveDocumentToKB(parsed, categoryId, tags, 'file', undefined, fileName, scenarioId);
}

/**
 * URL ingestion：抓取网页并提取正文
 */
export async function ingestUrl(
  url: string,
  categoryId: string = '__orphan__',
  tags: string[] = [],
  scenarioId?: string
): Promise<IngestUrlResult> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) {
    throw new Error(`抓取失败: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const parsed = parseHtml(buffer, url);
  const result = await saveDocumentToKB(parsed, categoryId, tags, 'url', url, parsed.title, scenarioId);
  return { ...result, url };
}

function buildRepoBody(meta: RepoMeta): string {
  const lines: string[] = [];
  lines.push(`仓库: ${meta.repo_url}`);
  lines.push(`分支: ${meta.repo_branch}`);
  if (meta.repo_commit) lines.push(`Commit: ${meta.repo_commit}`);
  lines.push(`文件数: ${meta.file_count}`);
  if (meta.readme) {
    lines.push('');
    lines.push('README:');
    lines.push(meta.readme.slice(0, 1200));
  }
  lines.push('');
  lines.push('文件树:');
  lines.push(meta.file_tree.slice(0, 50).join('\n'));
  return lines.join('\n').slice(0, 4000);
}

/**
 * 代码仓库 ingestion：克隆仓库、切片、索引
 */
export async function ingestRepo(
  repoUrl: string,
  categoryId: string = '__orphan__',
  tags: string[] = [],
  branch?: string,
  depth = 1,
  scenarioId?: string
): Promise<IngestRepoResult> {
  const repoId = makeRepoId(`${repoUrl}#${branch || 'HEAD'}`);
  const meta = await cloneOrUpdateRepo({ repoUrl, repoId, branch, depth });
  const files = readRepoTextFiles(meta.repo_dir, 1000, 500 * 1024);
  const chunks = chunkRepoFiles(files, {
    maxChunkSize: 1200,
    overlap: 120,
    maxFiles: 1000
  });

  const repoName = repoUrl
    .replace(/\.git$/, '')
    .split('/')
    .pop();
  const title = (repoName || '代码仓库').slice(0, 64);
  const body = buildRepoBody(meta);

  const item = kbStore.createItem(categoryId, title, body, tags, {
    scenario_id: scenarioId,
    source_type: 'repository',
    source_url: repoUrl,
    source_metadata: {
      repo_branch: meta.repo_branch,
      repo_commit: meta.repo_commit,
      file_count: meta.file_count,
      total_size_bytes: meta.total_size_bytes,
      file_tree: meta.file_tree
    },
    content_type: 'code'
  });

  if (!item) {
    throw new Error('创建 KBItem 失败，分类可能不存在');
  }

  const result = await kbStore.reindexItem(item.id, chunks);
  return {
    item_id: item.id,
    title: item.title,
    chunks: result?.chunks || 0,
    status: mapIndexStatus(result?.status),
    mime_type: 'application/vnd.git-repo',
    char_count: files.reduce((sum, f) => sum + f.content.length, 0),
    repo_url: meta.repo_url,
    branch: meta.repo_branch,
    commit: meta.repo_commit,
    file_count: meta.file_count
  };
}

/**
 * 消息 ingestion（已有 routes/kb.ts 使用，这里提供统一封装）
 */
export async function ingestMessage(
  message: string,
  title?: string,
  categoryId: string = '__orphan__',
  tags: string[] = [],
  scenarioId?: string
): Promise<IngestMessageResult> {
  const itemTitle = title ? title.slice(0, 64) : message.trim().slice(0, 64);
  const itemBody = message.trim().slice(0, 4000);
  const item = kbStore.createItem(categoryId, itemTitle, itemBody, tags, {
    scenario_id: scenarioId,
    source_type: 'chat',
    content_type: 'text'
  });
  if (!item) {
    throw new Error('创建 KBItem 失败，分类可能不存在');
  }
  const result = await kbStore.reindexItem(item.id);
  return {
    item_id: item.id,
    title: item.title,
    status: mapIndexStatus(result?.status)
  };
}
