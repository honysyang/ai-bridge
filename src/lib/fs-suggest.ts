// ======== v5.4.5: 文件系统路径补全 ========
//
// 提供"输入中"的路径补全建议，类似 shell 的 tab 补全：
//   - 用户输入 /ho  → 建议 ['home']
//   - 用户输入 /home/  → 建议 home 下的子目录
//   - 用户输入 /home/ka  → 建议 ['kali']
//   - 用户输入 / 或空 → 建议常见 dev 根目录
//
// 安全性：
//   - 路径长度限制（防 DoS）
//   - 只读操作（fs.readdirSync，不写盘）
//   - 单次返回数量限制（避免一次返回 1000 个）
//   - 扫描失败静默（权限/不存在）
//   - 不暴露 .ssh / .gnupg 等敏感目录

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface FsSuggestCandidate {
  name: string;        // basename
  path: string;        // 完整路径
  isDir: boolean;
  marker?: string;     // 项目标记（识别为代码项目时）
}

export interface FsSuggestResult {
  prefix: string;
  base: string;        // 父目录（补全的根）
  baseExists: boolean; // 父目录是否存在
  candidates: FsSuggestCandidate[];
}

const MAX_CANDIDATES = 12;
const MAX_PREFIX_LEN = 1024;
const MAX_SCAN_DEPTH = 1;

/** 项目标记文件（与 project-presets 共用） */
const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'setup.py', 'go.mod',
  'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'Gemfile', 'mix.exs', 'project.godot'
];

/** 常见 dev 根目录（仅在 prefix 为空或 / 时提示） */
const COMMON_ROOTS = [
  process.env.HOME || '/root',
  '/home',
  '/tmp',
  '/opt',
  '/srv',
  '/var/www',
  '/workspace',
  '/workspaces'
];

/** 敏感目录黑名单（不返回这些目录下的子目录） */
const SENSITIVE_DIRS = new Set([
  '.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.gcloud',
  '.kube', '.docker', '.config/gh', '.npmrc', '.pypirc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);

/** 检测目录是否含项目标记 */
function detectMarker(dir: string): string | undefined {
  for (const m of PROJECT_MARKERS) {
    try {
      if (fs.existsSync(path.join(dir, m))) return m;
    } catch { /* skip */ }
  }
  return undefined;
}

/** 安全读取目录（异常静默） */
function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 列出目录下可显示的子目录 */
function listSubdirs(dir: string, limit: number): FsSuggestCandidate[] {
  const entries = safeReaddir(dir);
  const out: FsSuggestCandidate[] = [];
  for (const ent of entries) {
    if (out.length >= limit) break;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    // 跳过隐藏目录（用户大概率不关心）
    if (ent.name.startsWith('.')) continue;
    // 跳过明显非项目目录
    if (ent.name === 'node_modules' || ent.name === '__pycache__' || ent.name === 'venv') continue;
    // 黑名单（敏感目录）
    if (SENSITIVE_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({
      name: ent.name,
      path: full,
      isDir: true,
      marker: detectMarker(full)
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * 核心补全函数
 * @param prefix 用户当前输入的路径（可能含 /）
 */
export function suggestPath(prefix: string): FsSuggestResult {
  const safePrefix = (prefix || '').slice(0, MAX_PREFIX_LEN);

  // 情况 1：空 / 只有 / → 提示常见 dev 根目录
  if (!safePrefix || safePrefix === '/') {
    const candidates: FsSuggestCandidate[] = [];
    for (const r of COMMON_ROOTS) {
      if (candidates.length >= MAX_CANDIDATES) break;
      try {
        if (fs.existsSync(r) && fs.statSync(r).isDirectory()) {
          candidates.push({
            name: r,
            path: r,
            isDir: true
          });
        }
      } catch { /* skip */ }
    }
    return {
      prefix: safePrefix,
      base: '/',
      baseExists: true,
      candidates
    };
  }

  // 情况 2：以 / 结尾 → 列出该目录的子目录（按字典序）
  if (safePrefix.endsWith('/')) {
    const base = safePrefix;
    const baseExists = fs.existsSync(base) && fs.statSync(base).isDirectory();
    const candidates = baseExists ? listSubdirs(base, MAX_CANDIDATES) : [];
    return { prefix: safePrefix, base, baseExists, candidates };
  }

  // 情况 3：未以 / 结尾 → 拆出父目录 + 当前段
  //   - /home/ka  → base=/home, query=ka
  //   - /hom       → base=/,    query=hom
  //   - ./foo      → base=./,   query=foo（不展开为绝对路径，保持相对语义）
  const idx = safePrefix.lastIndexOf('/');
  const base = idx >= 0 ? safePrefix.slice(0, idx) || '/' : '.';
  const query = idx >= 0 ? safePrefix.slice(idx + 1) : safePrefix;

  // base 必须存在，否则无候选
  let baseExists = false;
  try {
    baseExists = fs.existsSync(base) && fs.statSync(base).isDirectory();
  } catch { /* skip */ }

  if (!baseExists) {
    return { prefix: safePrefix, base, baseExists: false, candidates: [] };
  }

  // 列出 base 子目录，过滤以 query 开头的（大小写不敏感）
  const all = listSubdirs(base, MAX_CANDIDATES * 4);
  const lcQuery = query.toLowerCase();
  const filtered = query
    ? all.filter(c => c.name.toLowerCase().startsWith(lcQuery))
    : all;
  return {
    prefix: safePrefix,
    base,
    baseExists: true,
    candidates: filtered.slice(0, MAX_CANDIDATES)
  };
}
