// ======== Session Manager (v3.0.0) ========
// 封装 storage 提供会话 CRUD、默认会话懒创建、任务计数等业务逻辑

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionStatus, Task } from './types.js';
import { storage } from './storage.js';
import { childLogger } from './lib/logger.js';

const log = childLogger({ module: 'session' });

const DEFAULT_SESSION_ID = 'sess-default';
const DEFAULT_SESSION_NAME = '默认会话';

export interface CreateSessionInput {
  name: string;
  description?: string;
  project_dir?: string;
  meta?: Record<string, any>;
}

export interface UpdateSessionInput {
  name?: string;
  description?: string;
  project_dir?: string | null;
  status?: SessionStatus;
  meta?: Record<string, any>;
}

/**
 * 校验 project_dir：
 *   - 可选字段，缺省或空字符串视为未设置
 *   - 必须为绝对路径（以 / 开头）
 *   - 拒绝包含 `..` 的相对片段（防目录穿越）
 *   - 路径必须存在（且为目录），不存在则报错，避免 agent 写错目录
 *   - 规范化路径（去除尾随 /）
 */
export function validateProjectDir(input: string | null | undefined): string | undefined {
  if (input == null) return undefined;
  const trimmed = String(input).trim();
  if (!trimmed) return undefined;
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`项目目录必须是绝对路径: ${trimmed}`);
  }
  // 路径规范化后检查是否包含 ..
  const normalized = path.normalize(trimmed);
  const segments = normalized.split(path.sep);
  if (segments.includes('..')) {
    throw new Error(`项目目录不允许包含 '..': ${trimmed}`);
  }
  // 必须存在且为目录
  if (!fs.existsSync(normalized)) {
    throw new Error(`项目目录不存在: ${normalized}`);
  }
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    throw new Error(`项目路径不是目录: ${normalized}`);
  }
  // 去除尾随 /
  return normalized.replace(/[\\/]+$/, '');
}

export class SessionManager {
  private idCounter = 0;
  private defaultEnsured = false;

  constructor() {
    // 注意：不在 constructor 中 ensureDefaultSession，
    // 因为 storage.loadAll() 还没运行，会清空 in-memory state。
    // 由 server.ts.startServer() 在 loadAll 之后显式调用 ensureDefaultSession()。
  }

  // ======== Default Session ========

  /**
   * 确保默认会话存在。启动时和首次访问时调用。
   */
  ensureDefaultSession(): Session {
    const existing = storage.getSession(DEFAULT_SESSION_ID);
    if (existing) {
      this.defaultEnsured = true;
      return existing;
    }

    const now = Date.now();
    const defaultSession: Session = {
      id: DEFAULT_SESSION_ID,
      name: DEFAULT_SESSION_NAME,
      description: '未指定会话的任务会自动归入这里',
      created_at: now,
      updated_at: now,
      task_count: 0,
      status: 'active',
      meta: { is_default: true }
    };
    storage.appendSession(defaultSession);
    this.defaultEnsured = true;
    return defaultSession;
  }

  getDefaultSessionId(): string {
    return DEFAULT_SESSION_ID;
  }

  // ======== CRUD ========

  createSession(input: CreateSessionInput): Session {
    if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('会话名称不能为空');
    }
    const projectDir = validateProjectDir(input.project_dir);
    this.idCounter++;
    const now = Date.now();
    const session: Session = {
      id: `sess-${now}-${this.idCounter}`,
      name: input.name.trim(),
      description: input.description?.trim(),
      project_dir: projectDir,
      created_at: now,
      updated_at: now,
      task_count: 0,
      status: 'active',
      meta: input.meta
    };
    storage.appendSession(session);
    if (projectDir) {
      log.info(`会话 ${session.id} 绑定项目目录: ${projectDir}`);
    }
    return session;
  }

  getSession(id: string): Session | undefined {
    return storage.getSession(id);
  }

  /**
   * 获取会话（不存在则返回默认会话）
   */
  getSessionOrDefault(id?: string): Session {
    if (!id) return this.ensureDefaultSession();
    const session = storage.getSession(id);
    if (session) return session;
    // ID 不存在时返回默认会话
    return this.ensureDefaultSession();
  }

  listSessions(opts: {
    status?: SessionStatus;
    q?: string; // 搜索关键词（匹配 name/description）
  } = {}): Session[] {
    let arr = storage.getAllSessions();

    if (opts.status) {
      arr = arr.filter(s => s.status === opts.status);
    }
    if (opts.q) {
      const q = opts.q.toLowerCase();
      arr = arr.filter(s =>
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false)
      );
    }

    // 刷新 task_count（基于当前 task 列表）
    const taskCounts = this.computeTaskCounts();
    arr = arr.map(s => ({
      ...s,
      task_count: taskCounts.get(s.id) ?? 0,
      last_task_summary: this.getLastTaskSummary(s.id)
    }));

    // 按 updated_at 倒序
    return arr.sort((a, b) => b.updated_at - a.updated_at);
  }

  updateSession(id: string, patch: UpdateSessionInput): Session | null {
    if (id === DEFAULT_SESSION_ID && patch.status === 'archived') {
      throw new Error('默认会话不能归档');
    }
    if (patch.name !== undefined) {
      if (!patch.name.trim()) {
        throw new Error('会话名称不能为空');
      }
      patch.name = patch.name.trim();
    }
    // 构造干净的 patch 给 storage.updateSession（不包含 null，存 Partial<Session> 兼容）
    const cleanPatch: Partial<Session> = {};
    if (patch.name !== undefined) cleanPatch.name = patch.name;
    if (patch.description !== undefined) cleanPatch.description = patch.description;
    if (patch.status !== undefined) cleanPatch.status = patch.status;
    if (patch.meta !== undefined) cleanPatch.meta = patch.meta;
    if ('project_dir' in patch) {
      // 显式 null/空字符串视为清空；非空则校验
      if (patch.project_dir == null || (typeof patch.project_dir === 'string' && !patch.project_dir.trim())) {
        cleanPatch.project_dir = undefined;
      } else {
        cleanPatch.project_dir = validateProjectDir(patch.project_dir as string);
      }
    }
    const ok = storage.updateSession(id, cleanPatch);
    if (!ok) return null;
    return storage.getSession(id) || null;
  }

  deleteSession(id: string): { ok: boolean; reassigned_tasks: number } {
    if (id === DEFAULT_SESSION_ID) {
      throw new Error('默认会话不能删除');
    }
    const session = storage.getSession(id);
    if (!session) return { ok: false, reassigned_tasks: 0 };

    // 将归属该会话的任务重新分配到默认会话（数据保留）
    const allTasks = storage.getAllTasks();
    let reassigned = 0;
    for (const task of allTasks) {
      if ((task as any).session_id === id) {
        storage.updateTask(task.id, { session_id: DEFAULT_SESSION_ID } as any);
        reassigned++;
      }
    }

    storage.deleteSession(id);
    return { ok: true, reassigned_tasks: reassigned };
  }

  // ======== Helpers ========

  /**
   * 统计每个会话的任务数
   */
  private computeTaskCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const task of storage.getAllTasks()) {
      const sid = (task as any).session_id || DEFAULT_SESSION_ID;
      counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * 获取会话内最近一条任务的摘要
   */
  private getLastTaskSummary(sessionId: string): string | undefined {
    const tasks = storage.getRecentTasks(50, { session_id: sessionId } as any);
    if (tasks.length === 0) return undefined;
    const last = tasks[0];
    const content = last.data?.content || '';
    return content.length > 50 ? content.slice(0, 50) + '...' : content;
  }

  /**
   * 列出某会话下的任务
   */
  getSessionTasks(sessionId: string, limit: number = 50): Task[] {
    return storage.getRecentTasks(limit, { session_id: sessionId } as any);
  }

  /**
   * 刷新会话的 updated_at（任务变更时调用）
   */
  touchSession(sessionId: string): void {
    if (!sessionId) return;
    storage.updateSession(sessionId, { updated_at: Date.now() });
  }
}

export const sessionManager = new SessionManager();
