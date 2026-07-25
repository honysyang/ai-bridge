/**
 * Git 仓库克隆与元数据获取（v5.6.0）
 *
 * 使用 simple-git 将仓库克隆到 data/repos/<repoId>/
 * 支持限制：仓库总大小、最大文件数、忽略目录。
 */

import * as fs from 'fs';
import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import { DATA_DIR } from './paths.js';

const REPOS_DIR = path.join(DATA_DIR, 'repos');

export interface CloneRepoOptions {
  repoUrl: string;
  repoId: string;
  branch?: string;
  depth?: number;
}

export interface RepoMeta {
  repo_url: string;
  repo_branch: string;
  repo_commit?: string;
  repo_dir: string;
  file_count: number;
  total_size_bytes: number;
  readme?: string;
  file_tree: string[];
}

// 默认忽略目录与文件
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv'
]);
const IGNORE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.mp4',
  '.mp3',
  '.wav',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot'
]);

function ensureReposDir(): void {
  if (!fs.existsSync(REPOS_DIR)) {
    fs.mkdirSync(REPOS_DIR, { recursive: true });
  }
}

export function getRepoDir(repoId: string): string {
  return path.join(REPOS_DIR, repoId);
}

/**
 * 克隆或更新仓库
 */
export async function cloneOrUpdateRepo(opts: CloneRepoOptions): Promise<RepoMeta> {
  ensureReposDir();
  const repoDir = getRepoDir(opts.repoId);
  const git: SimpleGit = simpleGit();

  let localGit = simpleGit(repoDir);
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    // 已存在，尝试 pull
    try {
      await localGit.pull('origin', opts.branch || 'HEAD', ['--ff-only']);
    } catch (e) {
      console.warn(`[git-clone] pull failed for ${opts.repoId}:`, (e as Error).message);
    }
  } else {
    // 新建克隆
    const cloneArgs = ['--no-tags'];
    if (opts.branch) cloneArgs.push('--branch', opts.branch);
    if (opts.depth && opts.depth > 0) cloneArgs.push('--depth', String(opts.depth));
    await git.clone(opts.repoUrl, repoDir, cloneArgs);
    localGit = simpleGit(repoDir);
  }

  const actualBranch = opts.branch || (await localGit.revparse(['--abbrev-ref', 'HEAD']).catch(() => 'HEAD'));
  return collectRepoMeta(repoDir, opts.repoUrl, actualBranch);
}

/**
 * 收集仓库元数据与文件树
 */
export async function collectRepoMeta(repoDir: string, repoUrl: string, branch: string): Promise<RepoMeta> {
  const git = simpleGit(repoDir);
  const log = await git.log({ n: 1 }).catch(() => ({ latest: undefined }));
  const commit = log.latest?.hash;

  const readme = findReadme(repoDir);
  const fileTree: string[] = [];
  let totalSize = 0;
  let fileCount = 0;

  function walk(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        walk(path.join(dir, ent.name), prefix ? `${prefix}/${ent.name}` : ent.name);
      } else if (ent.isFile()) {
        const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
        const ext = path.extname(ent.name).toLowerCase();
        if (IGNORE_EXTS.has(ext)) continue;
        const stat = fs.statSync(path.join(dir, ent.name));
        fileTree.push(relPath);
        totalSize += stat.size;
        fileCount++;
      }
    }
  }

  if (fs.existsSync(repoDir)) walk(repoDir, '');

  return {
    repo_url: repoUrl,
    repo_branch: branch,
    repo_commit: commit,
    repo_dir: repoDir,
    file_count: fileCount,
    total_size_bytes: totalSize,
    readme,
    file_tree: fileTree.slice(0, 1000) // 限制文件树长度
  };
}

function findReadme(repoDir: string): string | undefined {
  const names = ['README.md', 'readme.md', 'README.MD', 'README.txt', 'README'];
  for (const name of names) {
    const p = path.join(repoDir, name);
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, 'utf-8').slice(0, 2000);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * 读取仓库中所有文本文件内容
 */
export function readRepoTextFiles(
  repoDir: string,
  maxFiles: number = 1000,
  maxSizePerFile: number = 500 * 1024
): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];

  function walk(dir: string, prefix: string) {
    if (out.length >= maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        walk(path.join(dir, ent.name), prefix ? `${prefix}/${ent.name}` : ent.name);
      } else if (ent.isFile()) {
        const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
        const ext = path.extname(ent.name).toLowerCase();
        if (IGNORE_EXTS.has(ext)) continue;
        const fullPath = path.join(dir, ent.name);
        const stat = fs.statSync(fullPath);
        if (stat.size > maxSizePerFile) continue;
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.length > 0) {
            out.push({ path: relPath, content });
          }
        } catch {
          // 二进制或编码问题，跳过
        }
      }
    }
  }

  if (fs.existsSync(repoDir)) walk(repoDir, '');
  return out;
}

/**
 * 生成 repoId（URL 的 hash）
 */
export function makeRepoId(repoUrl: string): string {
  const normalized = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
  const hash = Buffer.from(normalized)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 16);
  return `repo-${hash}`;
}
