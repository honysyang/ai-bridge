// ======== 审计日志（v5.5.6 产品化）========
//
// 目标：记录"谁在什么时间做了什么"，用于安全审计与合规。
// 存储：data/audit.jsonl（append-only，与 tasks/logs 一致）
// 特点：
//   - 独立文件，不混入业务日志
//   - 包含操作者 IP、用户代理、变更前后值
//   - 仅 admin 可通过 /api/system/audit 查询

import * as fs from 'fs';
import * as path from 'path';
import { childLogger } from './logger.js';
import { DATA_DIR } from './paths.js';

const log = childLogger({ module: 'audit' });

const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');

export type AuditAction =
  | 'auth:login:success'
  | 'auth:login:failed'
  | 'auth:logout'
  | 'auth:password:changed'
  | 'auth:password:reset'
  | 'user:create'
  | 'user:update'
  | 'user:delete'
  | 'storage:export'
  | 'storage:import'
  | 'storage:wipe'
  | 'system:settings:update'
  | 'system:settings:reset'
  | 'system:cleanup'
  | 'system:maintenance'
  | 'system:sqlite:migrate'
  | 'claw:login:start'
  | 'claw:logout'
  | 'other';

export interface AuditEntry {
  id: string;
  timestamp: number;
  action: AuditAction;
  actor?: { id?: string; username?: string; role?: string } | null;
  ip?: string;
  userAgent?: string;
  target?: string;
  before?: any;
  after?: any;
  detail?: string;
}

let nextId = 1;

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function generateId(): string {
  return `audit-${Date.now()}-${nextId++}`;
}

export function writeAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
  ensureDir();
  const full: AuditEntry = {
    id: generateId(),
    timestamp: Date.now(),
    ...entry
  };
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(full) + '\n', { mode: 0o600 });
  } catch (e: any) {
    log.error('审计日志写入失败', { error: e.message });
  }
}

export function readAudit(
  options: {
    limit?: number;
    action?: string;
    actor?: string;
    since?: number;
  } = {}
): AuditEntry[] {
  ensureDir();
  if (!fs.existsSync(AUDIT_FILE)) return [];

  const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip corrupted
    }
  }

  let filtered = entries;
  if (options.action) filtered = filtered.filter((e) => e.action === options.action);
  if (options.actor)
    filtered = filtered.filter((e) => e.actor?.username === options.actor || e.actor?.id === options.actor);
  if (options.since) filtered = filtered.filter((e) => e.timestamp >= options.since!);

  filtered.sort((a, b) => b.timestamp - a.timestamp);
  const limit = options.limit ?? 100;
  return filtered.slice(0, limit);
}

export function getAuditStats(): { count: number; file_size: number } {
  ensureDir();
  let fileSize = 0;
  try {
    fileSize = fs.statSync(AUDIT_FILE).size;
  } catch {
    // ignore
  }
  return {
    count: readAudit({ limit: Infinity }).length,
    file_size: fileSize
  };
}
