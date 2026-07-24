// ======== SQLite 查询层（v5.4.2）========
//
// 设计原则：
//   1. JSONL 仍是 source of truth（简单、可读、append-only）
//   2. SQLite 作为查询层（O(log N) 索引 vs JSONL 的 O(N) 全表扫描）
//   3. 启动时从 JSONL 同步一次（如果 SQLite 为空）
//   4. 写操作时双写（同步更新 SQLite，保持最终一致）
//   5. 失败容错：SQLite 写失败不影响 JSONL 写入（写日志告警）
//
// Schema：
//   - tasks(id PK, session_id, type, priority, source, status, created_at, started_at, completed_at, data_json, result_json)
//   - sessions(id PK, name, status, project_dir, created_at, updated_at, ...)
//   - logs(id PK, level, source, message, created_at, meta_json)
//   - kb_items / kb_links / workflows / users（按需）
//
// 索引：
//   - tasks(status, created_at DESC)
//   - tasks(session_id, created_at DESC)
//   - tasks(source, created_at)
//   - sessions(status, updated_at DESC)
//   - logs(level, created_at DESC)

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { Task, Session, LogEntry } from '../types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'ai-bridge.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  context_json TEXT,
  project_dir TEXT,
  result_json TEXT,
  assigned_to TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  project_dir TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  task_count INTEGER DEFAULT 0,
  last_task_summary TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_level_created ON logs(level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);

CREATE TABLE IF NOT EXISTS kb_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_items (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_items_category ON kb_items(category_id);
CREATE INDEX IF NOT EXISTS idx_kb_items_updated ON kb_items(updated_at DESC);

CREATE TABLE IF NOT EXISTS kb_links (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_links_source ON kb_links(source_id);
CREATE INDEX IF NOT EXISTS idx_kb_links_target ON kb_links(target_id);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  steps_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  display_name TEXT,
  wechat_wxid TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_wxid ON users(wechat_wxid);

-- 迁移元信息表
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class SqliteStore {
  private db: Database.Database;
  private writeErrors = 0;

  // 预编译语句（性能关键）
  private stmts: {
    insertTask: Database.Statement;
    updateTask: Database.Statement;
    deleteTask: Database.Statement;
    insertSession: Database.Statement;
    updateSession: Database.Statement;
    deleteSession: Database.Statement;
    insertLog: Database.Statement;
    insertKBItem: Database.Statement;
    insertKBLink: Database.Statement;
  };

  constructor(dbPath: string = DB_FILE) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this.stmts = {
      insertTask: this.db.prepare(`
        INSERT OR REPLACE INTO tasks (id, session_id, type, priority, source, status, data_json, context_json, project_dir, result_json, assigned_to, created_at, started_at, completed_at)
        VALUES (@id, @session_id, @type, @priority, @source, @status, @data_json, @context_json, @project_dir, @result_json, @assigned_to, @created_at, @started_at, @completed_at)
      `),
      updateTask: this.db.prepare(`UPDATE tasks SET status = @status, result_json = @result_json, started_at = @started_at, completed_at = @completed_at, assigned_to = @assigned_to WHERE id = @id`),
      deleteTask: this.db.prepare(`DELETE FROM tasks WHERE id = ?`),
      insertSession: this.db.prepare(`
        INSERT OR REPLACE INTO sessions (id, name, description, status, project_dir, created_at, updated_at, task_count, last_task_summary, meta_json)
        VALUES (@id, @name, @description, @status, @project_dir, @created_at, @updated_at, @task_count, @last_task_summary, @meta_json)
      `),
      updateSession: this.db.prepare(`UPDATE sessions SET name = @name, description = @description, status = @status, project_dir = @project_dir, updated_at = @updated_at, last_task_summary = @last_task_summary, meta_json = @meta_json WHERE id = @id`),
      deleteSession: this.db.prepare(`DELETE FROM sessions WHERE id = ?`),
      insertLog: this.db.prepare(`
        INSERT OR REPLACE INTO logs (id, level, source, message, created_at, meta_json)
        VALUES (@id, @level, @source, @message, @created_at, @meta_json)
      `),
      insertKBItem: this.db.prepare(`
        INSERT OR REPLACE INTO kb_items (id, category_id, title, body, tags, created_at, updated_at)
        VALUES (@id, @category_id, @title, @body, @tags, @created_at, @updated_at)
      `),
      insertKBLink: this.db.prepare(`
        INSERT OR REPLACE INTO kb_links (id, source_id, target_id, type, label, created_at)
        VALUES (@id, @source_id, @target_id, @type, @label, @created_at)
      `)
    };
  }

  /**
   * 健康检查
   */
  isHealthy(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 数据库文件大小
   */
  getDbFileSize(): number {
    try {
      return fs.statSync(DB_FILE).size;
    } catch {
      return 0;
    }
  }

  /**
   * 写错误计数（用于监控 SQLite 降级）
   */
  getWriteErrors(): number {
    return this.writeErrors;
  }

  // ======== 写操作（带 try-catch 防止 SQLite 失败影响 JSONL）=======

  upsertTask(t: Task): void {
    try {
      this.stmts.insertTask.run({
        id: t.id,
        session_id: t.session_id || null,
        type: t.type,
        priority: t.priority,
        source: t.source,
        status: t.status,
        data_json: JSON.stringify(t.data || {}),
        context_json: t.context ? JSON.stringify(t.context) : null,
        project_dir: t.project_dir || null,
        result_json: t.result ? JSON.stringify(t.result) : null,
        assigned_to: t.assigned_to || null,
        created_at: t.created_at,
        started_at: t.started_at || null,
        completed_at: t.completed_at || null
      });
    } catch (e: any) {
      this.writeErrors++;
      console.error('[sqlite] upsertTask failed:', e.message);
    }
  }

  updateTaskStatus(id: string, fields: { status?: string; result?: any; started_at?: number; completed_at?: number; assigned_to?: string }): void {
    try {
      this.stmts.updateTask.run({
        id,
        status: fields.status || null,
        result_json: fields.result ? JSON.stringify(fields.result) : null,
        started_at: fields.started_at || null,
        completed_at: fields.completed_at || null,
        assigned_to: fields.assigned_to || null
      });
    } catch (e: any) {
      this.writeErrors++;
      console.error('[sqlite] updateTaskStatus failed:', e.message);
    }
  }

  deleteTask(id: string): void {
    try {
      this.stmts.deleteTask.run(id);
    } catch (e: any) {
      this.writeErrors++;
    }
  }

  upsertSession(s: Session): void {
    try {
      this.stmts.insertSession.run({
        id: s.id,
        name: s.name,
        description: s.description || null,
        status: s.status,
        project_dir: s.project_dir || null,
        created_at: s.created_at,
        updated_at: s.updated_at,
        task_count: s.task_count || 0,
        last_task_summary: s.last_task_summary || null,
        meta_json: s.meta ? JSON.stringify(s.meta) : null
      });
    } catch (e: any) {
      this.writeErrors++;
    }
  }

  updateSessionMeta(id: string, fields: { name?: string; description?: string; status?: string; project_dir?: string; updated_at?: number; last_task_summary?: string; meta?: any }): void {
    try {
      this.stmts.updateSession.run({
        id,
        name: fields.name,
        description: fields.description,
        status: fields.status,
        project_dir: fields.project_dir,
        updated_at: fields.updated_at || Date.now(),
        last_task_summary: fields.last_task_summary,
        meta_json: fields.meta ? JSON.stringify(fields.meta) : null
      });
    } catch (e: any) {
      this.writeErrors++;
    }
  }

  deleteSession(id: string): void {
    try {
      this.stmts.deleteSession.run(id);
    } catch (e: any) {
      this.writeErrors++;
    }
  }

  upsertLog(e: LogEntry): void {
    try {
      this.stmts.insertLog.run({
        id: e.id,
        level: e.level,
        source: e.source,
        message: e.message,
        created_at: e.created_at,
        meta_json: e.meta ? JSON.stringify(e.meta) : null
      });
    } catch (err: any) {
      this.writeErrors++;
    }
  }

  // ======== 读操作（高性能查询）=======

  /**
   * 任务统计（替代 getCountByStatus 的 O(N) 扫描）
   */
  getTaskStats(): { pending: number; assigned: number; processing: number; completed: number; failed: number; total: number } {
    try {
      const rows = this.db.prepare(`SELECT status, COUNT(*) as n FROM tasks GROUP BY status`).all() as { status: string; n: number }[];
      const counts = { pending: 0, assigned: 0, processing: 0, completed: 0, failed: 0, total: 0 };
      for (const r of rows) {
        counts.total += r.n;
        if (r.status in counts) (counts as any)[r.status] = r.n;
      }
      return counts;
    } catch {
      return { pending: 0, assigned: 0, processing: 0, completed: 0, failed: 0, total: 0 };
    }
  }

  /**
   * 最近任务（按过滤器，支持 status, source, session_id, type, 多状态）
   */
  getRecentTasks(limit: number, filter?: { status?: string | string[]; type?: string; source?: string; session_id?: string }): Task[] {
    try {
      const where: string[] = [];
      const params: any = { limit };
      if (filter?.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : String(filter.status).split(',').map(s => s.trim());
        if (statuses.length === 1) {
          where.push('status = @status');
          params.status = statuses[0];
        } else if (statuses.length > 1) {
          where.push(`status IN (${statuses.map((_, i) => `@status${i}`).join(',')})`);
          statuses.forEach((s, i) => { params[`status${i}`] = s; });
        }
      }
      if (filter?.type) {
        where.push('type = @type');
        params.type = filter.type;
      }
      if (filter?.source) {
        where.push('source = @source');
        params.source = filter.source;
      }
      if (filter?.session_id) {
        where.push('session_id = @session_id');
        params.session_id = filter.session_id;
      }
      const sql = `
        SELECT * FROM tasks
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC
        LIMIT @limit
      `;
      const rows = this.db.prepare(sql).all(params) as any[];
      return rows.map(r => this.hydrateTask(r));
    } catch (e: any) {
      console.error('[sqlite] getRecentTasks failed:', e.message);
      return [];
    }
  }

  /**
   * 单任务查询
   */
  getTask(id: string): Task | null {
    try {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
      return row ? this.hydrateTask(row) : null;
    } catch {
      return null;
    }
  }

  /**
   * 任务趋势（近 N 天，按天聚合）
   */
  getTaskTrend(days: number = 7): { date: string; count: number; success: number }[] {
    try {
      const since = Date.now() - days * 86400_000;
      const rows = this.db.prepare(`
        SELECT
          strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as date,
          COUNT(*) as count,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success
        FROM tasks
        WHERE created_at >= ?
        GROUP BY date
        ORDER BY date ASC
      `).all(since) as { date: string; count: number; success: number }[];

      // 补齐缺失的日期
      const map = new Map(rows.map(r => [r.date, r]));
      const out: { date: string; count: number; success: number }[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400_000);
        const ds = d.toISOString().slice(0, 10);
        out.push(map.get(ds) || { date: ds, count: 0, success: 0 });
      }
      return out;
    } catch (e: any) {
      console.error('[sqlite] getTaskTrend failed:', e.message);
      return [];
    }
  }

  /**
   * 任务来源分布
   */
  getSourceDist(): Record<string, number> {
    try {
      const rows = this.db.prepare(`
        SELECT source, COUNT(*) as n FROM tasks GROUP BY source
      `).all() as { source: string; n: number }[];
      const out: Record<string, number> = {};
      for (const r of rows) out[r.source] = r.n;
      return out;
    } catch {
      return {};
    }
  }

  /**
   * 成功任务数（用于成功率）
   */
  getSuccessStats(): { total: number; completed: number; failed: number; success_rate: number } {
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM tasks
        WHERE status IN ('completed', 'failed')
      `).get() as any;
      const total = row?.completed + row?.failed || 0;
      return {
        total: row?.total || 0,
        completed: row?.completed || 0,
        failed: row?.failed || 0,
        success_rate: total > 0 ? Math.round((row.completed / total) * 100) : 0
      };
    } catch {
      return { total: 0, completed: 0, failed: 0, success_rate: 0 };
    }
  }

  /**
   * 会话统计
   */
  getSessionStats(): { total: number; active: number; archived: number } {
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived
        FROM sessions
      `).get() as any;
      return { total: row?.total || 0, active: row?.active || 0, archived: row?.archived || 0 };
    } catch {
      return { total: 0, active: 0, archived: 0 };
    }
  }

  /**
   * 会话列表
   */
  getSessions(opts: { status?: string; q?: string; limit?: number } = {}): Session[] {
    try {
      const where: string[] = [];
      const params: any = {};
      if (opts.status) {
        where.push('status = @status');
        params.status = opts.status;
      }
      if (opts.q) {
        where.push('(name LIKE @q OR description LIKE @q)');
        params.q = `%${opts.q}%`;
      }
      const sql = `
        SELECT * FROM sessions
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY updated_at DESC
        LIMIT @limit
      `;
      params.limit = opts.limit || 100;
      const rows = this.db.prepare(sql).all(params) as any[];
      return rows.map(r => this.hydrateSession(r));
    } catch {
      return [];
    }
  }

  /**
   * 单会话查询
   */
  getSession(id: string): Session | null {
    try {
      const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
      return row ? this.hydrateSession(row) : null;
    } catch {
      return null;
    }
  }

  /**
   * 各表行数
   */
  getTableCounts(): Record<string, number> {
    try {
      const tables = ['tasks', 'sessions', 'logs', 'kb_items', 'kb_categories', 'kb_links', 'workflows', 'users'];
      const counts: Record<string, number> = {};
      for (const t of tables) {
        try {
          const row = this.db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get() as any;
          counts[t] = row?.n || 0;
        } catch {
          counts[t] = 0;
        }
      }
      return counts;
    } catch {
      return {};
    }
  }

  /**
   * 元信息（迁移版本等）
   */
  getMeta(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM _meta WHERE key = ?').get(key) as any;
      return row?.value || null;
    } catch {
      return null;
    }
  }

  setMeta(key: string, value: string): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO _meta (key, value, updated_at) VALUES (?, ?, ?)
      `).run(key, value, Date.now());
    } catch {
      // ignore
    }
  }

  // ======== 迁移工具 ========

  /**
   * 从 JSONL 批量导入任务
   */
  bulkInsertTasks(tasks: Task[]): number {
    const insert = this.db.transaction((rows: Task[]) => {
      for (const t of rows) this.upsertTask(t);
    });
    try {
      insert(tasks);
      return tasks.length;
    } catch (e: any) {
      console.error('[sqlite] bulkInsertTasks failed:', e.message);
      return 0;
    }
  }

  bulkInsertSessions(sessions: Session[]): number {
    const insert = this.db.transaction((rows: Session[]) => {
      for (const s of rows) this.upsertSession(s);
    });
    try {
      insert(sessions);
      return sessions.length;
    } catch {
      return 0;
    }
  }

  bulkInsertLogs(logs: LogEntry[]): number {
    const insert = this.db.transaction((rows: LogEntry[]) => {
      for (const e of rows) this.upsertLog(e);
    });
    try {
      insert(logs);
      return logs.length;
    } catch {
      return 0;
    }
  }

  // ======== 内部辅助 ========

  private hydrateTask(r: any): Task {
    return {
      id: r.id,
      session_id: r.session_id,
      type: r.type,
      priority: r.priority,
      source: r.source,
      status: r.status,
      data: r.data_json ? JSON.parse(r.data_json) : {},
      context: r.context_json ? JSON.parse(r.context_json) : undefined,
      project_dir: r.project_dir,
      result: r.result_json ? JSON.parse(r.result_json) : undefined,
      assigned_to: r.assigned_to,
      created_at: r.created_at,
      started_at: r.started_at || undefined,
      completed_at: r.completed_at || undefined
    };
  }

  private hydrateSession(r: any): Session {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      project_dir: r.project_dir,
      created_at: r.created_at,
      updated_at: r.updated_at,
      task_count: r.task_count || 0,
      last_task_summary: r.last_task_summary,
      meta: r.meta_json ? JSON.parse(r.meta_json) : undefined
    };
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

export const sqliteStore = new SqliteStore();
