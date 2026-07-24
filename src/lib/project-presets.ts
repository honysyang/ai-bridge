// ======== v5.4.4: 项目目录预设 ========
//
// 提供"项目目录"输入的候选列表，避免用户输入不存在/拼写错误的路径。
//
// 预设来源（按优先级排序）：
//   1. 静态常见 dev 根目录（HOME, /tmp, /opt, /srv ...）
//   2. 扫描发现：常见 dev 根目录下的子目录，含项目标记文件
//      （.git / package.json / pyproject.toml / go.mod / Cargo.toml / pom.xml / build.gradle）
//   3. 最近使用：现有 session 绑定过的 project_dir（去重）
//
// 设计原则：
//  - 预设 API 只读，不写盘
//  - 扫描深度限制 2 层，避免 O(N) 扫描整盘
//  - 每个候选都做存在性校验（fs.existsSync），不返回不存在的路径
//  - 失败安全：扫描异常时只跳过该项，不抛错

import * as fs from 'fs';
import * as path from 'path';
import { storage } from '../storage.js';

export interface ProjectDirPreset {
  path: string;             // 绝对路径
  label: string;            // 短标签（用户展示用）
  category: 'common' | 'discovered' | 'recent';
  exists: boolean;          // 是否存在（恒为 true，因为过滤过）
  marker?: string;          // 项目标记文件名（discovered 时有）
}

/** 静态常见 dev 根目录（按用户场景优先级排序） */
const STATIC_COMMON_ROOTS: Array<{ path: string; label: string }> = [
  { path: process.env.HOME || '/root', label: '🏠 HOME 目录' },
  { path: '/home', label: '📁 /home (用户根)' },
  { path: '/tmp', label: '🧪 /tmp (临时)' },
  { path: '/opt', label: '📦 /opt (软件)' },
  { path: '/srv', label: '🌐 /srv (服务)' },
  { path: '/var/www', label: '🌍 /var/www (站点)' },
  { path: '/workspace', label: '💼 /workspace (开发容器)' },
  { path: '/workspaces', label: '💼 /workspaces (Codespaces)' }
];

/** 扫描发现的项目根目录时识别的标记文件 */
const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'project.godot'
];

/** 最大扫描深度（在 STATIC_COMMON_ROOTS 之下再向下扫 1 层） */
const SCAN_MAX_DEPTH = 1;

/** 单根目录最多返回的发现数（避免一个根下扫出 100 项） */
const SCAN_MAX_PER_ROOT = 12;

/** 总候选上限（防止 UI 爆炸） */
const TOTAL_MAX = 40;

/**
 * 扫描单个根目录的子目录，识别项目根
 */
function scanRoot(rootPath: string, depth: number, results: ProjectDirPreset[]): void {
  if (results.length >= SCAN_MAX_PER_ROOT) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return; // 没权限/不存在/不是目录 → 静默跳过
  }
  for (const ent of entries) {
    if (results.length >= SCAN_MAX_PER_ROOT) break;
    // 跳过隐藏目录（除 .well-known 等）和明显非项目目录
    if (ent.name.startsWith('.') && ent.name !== '.well-known') continue;
    if (ent.name === 'node_modules' || ent.name === 'venv' || ent.name === '__pycache__') continue;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const full = path.join(rootPath, ent.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    // 找项目标记
    let foundMarker: string | undefined;
    for (const marker of PROJECT_MARKERS) {
      try {
        if (fs.existsSync(path.join(full, marker))) {
          foundMarker = marker;
          break;
        }
      } catch { /* skip */ }
    }
    if (foundMarker) {
      results.push({
        path: full,
        label: `📦 ${ent.name}`,
        category: 'discovered',
        exists: true,
        marker: foundMarker
      });
    } else if (depth < SCAN_MAX_DEPTH) {
      // 递归一层（带隐藏子目录判断）
      scanRoot(full, depth + 1, results);
    }
  }
}

/**
 * 提取最近使用过的项目目录（从已有 session 拿，最多 5 个）
 */
function recentPresets(): ProjectDirPreset[] {
  const sessions = storage.getAllSessions();
  const seen = new Set<string>();
  const out: ProjectDirPreset[] = [];
  // 按 updated_at 倒序
  const sorted = [...sessions].sort((a, b) => b.updated_at - a.updated_at);
  for (const s of sorted) {
    if (out.length >= 5) break;
    const dir = (s as any).project_dir;
    if (!dir || typeof dir !== 'string') continue;
    if (seen.has(dir)) continue;
    if (!fs.existsSync(dir)) continue;
    seen.add(dir);
    out.push({
      path: dir,
      label: `🕘 ${path.basename(dir)} (${s.name || '会话'})`,
      category: 'recent',
      exists: true
    });
  }
  return out;
}

/**
 * 收集所有项目目录预设（去重 + 排序 + 截断）
 */
export function getProjectDirPresets(): {
  presets: ProjectDirPreset[];
  total: number;
  sources: { common: number; discovered: number; recent: number };
} {
  const all: ProjectDirPreset[] = [];

  // 1) 静态 common 根（先按存在性过滤）
  for (const r of STATIC_COMMON_ROOTS) {
    if (fs.existsSync(r.path) && fs.statSync(r.path).isDirectory()) {
      all.push({
        path: r.path,
        label: r.label,
        category: 'common',
        exists: true
      });
    }
  }

  // 2) 扫描发现（在每个 common 根下扫一层，去重）
  const seenPaths = new Set(all.map(p => p.path));
  for (const r of STATIC_COMMON_ROOTS) {
    if (!fs.existsSync(r.path)) continue;
    const found: ProjectDirPreset[] = [];
    scanRoot(r.path, 0, found);
    for (const p of found) {
      if (seenPaths.has(p.path)) continue; // 去重（/home 和 /home/kali 会扫到相同的子目录）
      seenPaths.add(p.path);
      all.push(p);
      if (all.length >= TOTAL_MAX) break;
    }
    if (all.length >= TOTAL_MAX) break;
  }

  // 3) 最近使用（追加在末尾，按时间倒序）
  const recent = recentPresets();
  for (const p of recent) {
    if (!seenPaths.has(p.path)) {
      seenPaths.add(p.path);
      all.push(p);
    }
  }

  const truncated = all.slice(0, TOTAL_MAX);
  const sources = {
    common: truncated.filter(p => p.category === 'common').length,
    discovered: truncated.filter(p => p.category === 'discovered').length,
    recent: truncated.filter(p => p.category === 'recent').length
  };
  return { presets: truncated, total: truncated.length, sources };
}
