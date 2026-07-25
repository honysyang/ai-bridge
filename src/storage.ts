// ======== JSONL Storage (v3.0.0) ========
// Append-only event log for tasks, logs, and sessions.
// Each line in tasks.jsonl is one of:
//   { "op": "create", "task": {...} }
//   { "op": "update", "id": "...", "patch": {...} }
//   { "op": "delete", "id": "..." }
// logs.jsonl: append-only (each line is a LogEntry)
// sessions.jsonl: similar ops as tasks (Phase B will use)

import * as fs from 'fs';
import * as path from 'path';
import { Task, LogEntry, Session } from './types.js';
import { sqliteStore } from './lib/sqlite-store.js';
import { DATA_DIR } from './lib/paths.js';

const TASKS_FILE = path.join(DATA_DIR, 'tasks.jsonl');
const LOGS_FILE = path.join(DATA_DIR, 'logs.jsonl');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');
const CORRUPTED_DIR = path.join(DATA_DIR, '.corrupted');

// v5.4.2: 是否启用 SQLite 同步（默认开；可通过 AIBRIDGE_SQLITE_SYNC=0 关闭）
const SQLITE_SYNC = process.env.AIBRIDGE_SQLITE_SYNC !== '0';

// ======== Op Types ========

export type TaskOp =
  { op: 'create'; task: Task } | { op: 'update'; id: string; patch: Partial<Task> } | { op: 'delete'; id: string };

export type SessionOp =
  | { op: 'create'; session: Session }
  | { op: 'update'; id: string; patch: Partial<Session> }
  | { op: 'delete'; id: string };

// ======== Storage Class ========

export class Storage {
  // In-memory state
  private tasks: Map<string, Task> = new Map();
  private taskOrder: string[] = []; // preserve insertion order
  private sessions: Map<string, Session> = new Map();
  private sessionOrder: string[] = [];
  private logs: LogEntry[] = [];
  private logsTotal: number = 0; // total lines read (including ones trimmed from memory)

  // Async write serialization
  private writeQueue: Promise<void> = Promise.resolve();
  private writeCount: number = 0;
  private writeErrors: number = 0;

  // Limits
  private readonly LOG_MEMORY_LIMIT = 500;
  private readonly TASK_MEMORY_LIMIT = 2000;

  constructor() {
    this.ensureDataDir();
  }

  // ======== Lifecycle ========

  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CORRUPTED_DIR)) {
      fs.mkdirSync(CORRUPTED_DIR, { recursive: true });
    }
  }

  /**
   * Load all data from JSONL files into memory.
   * Call once at startup, before serving requests.
   */
  loadAll(): { tasks: number; logs: number; sessions: number; corrupted: number } {
    const tasksLoaded = this.loadTasks();
    const logsLoaded = this.loadLogs();
    const sessionsLoaded = this.loadSessions();
    return {
      tasks: tasksLoaded.count,
      logs: logsLoaded.count,
      sessions: sessionsLoaded.count,
      corrupted: tasksLoaded.corrupted + logsLoaded.corrupted + sessionsLoaded.corrupted
    };
  }

  /**
   * Wait for all pending writes to flush (use before shutdown or export).
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  // ======== Task Operations ========

  async appendTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
    this.taskOrder.push(task.id);
    this.enforceTaskMemoryLimit();
    await this.appendLine(TASKS_FILE, { op: 'create', task });
    if (SQLITE_SYNC) sqliteStore.upsertTask(task);
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<boolean> {
    const existing = this.tasks.get(id);
    if (!existing) return false;
    const updated: Task = { ...existing, ...patch };
    this.tasks.set(id, updated);
    await this.appendLine(TASKS_FILE, { op: 'update', id, patch });
    if (SQLITE_SYNC) sqliteStore.upsertTask(updated);
    return true;
  }

  async deleteTask(id: string): Promise<boolean> {
    if (!this.tasks.has(id)) return false;
    this.tasks.delete(id);
    const idx = this.taskOrder.indexOf(id);
    if (idx >= 0) this.taskOrder.splice(idx, 1);
    await this.appendLine(TASKS_FILE, { op: 'delete', id });
    if (SQLITE_SYNC) sqliteStore.deleteTask(id);
    return true;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return this.taskOrder.map((id) => this.tasks.get(id)).filter((t): t is Task => t !== undefined);
  }

  getRecentTasks(
    limit: number = 50,
    filter?: {
      status?: Task['status'];
      type?: Task['type'];
      source?: Task['source'];
      session_id?: string;
      offset?: number;
    }
  ): Task[] {
    const offset = filter?.offset || 0;

    // v5.5.6: 当查询窗口超出内存保留范围（TASK_MEMORY_LIMIT）且 SQLite 同步开启时，
    // 回查 SQLite 索引层，避免老任务“消失”。
    if (SQLITE_SYNC && offset + limit > this.taskOrder.length) {
      return sqliteStore.getRecentTasks(limit, { ...filter, offset });
    }

    let arr = this.getAllTasks();
    if (filter?.status) {
      // v5.1.1: 支持多状态过滤（逗号分隔），如 status=assigned,processing
      const statuses = String(filter.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      arr =
        statuses.length > 1
          ? arr.filter((t) => statuses.includes(t.status))
          : arr.filter((t) => t.status === filter!.status);
    }
    if (filter?.type) arr = arr.filter((t) => t.type === filter.type);
    if (filter?.source) arr = arr.filter((t) => t.source === filter.source);
    if (filter?.session_id) arr = arr.filter((t) => (t as any).session_id === filter.session_id);
    return arr.sort((a, b) => b.created_at - a.created_at).slice(offset, offset + limit);
  }

  countTasks(filter?: {
    status?: Task['status'];
    type?: Task['type'];
    source?: Task['source'];
    session_id?: string;
  }): number {
    let arr = this.getAllTasks();
    if (filter?.status) {
      const statuses = String(filter.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      arr =
        statuses.length > 1
          ? arr.filter((t) => statuses.includes(t.status))
          : arr.filter((t) => t.status === filter!.status);
    }
    if (filter?.type) arr = arr.filter((t) => t.type === filter.type);
    if (filter?.source) arr = arr.filter((t) => t.source === filter.source);
    if (filter?.session_id) arr = arr.filter((t) => (t as any).session_id === filter.session_id);
    return arr.length;
  }

  getTasksBySession(sessionId: string): Task[] {
    return this.getAllTasks().filter((t: any) => t.session_id === sessionId);
  }

  /**
   * Count tasks grouped by status in a single pass (O(N)).
   * Replaces 4× array.filter().length calls previously used in TaskQueue.getStats().
   */
  getCountByStatus(): {
    pending: number;
    assigned: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
  } {
    const counts = {
      pending: 0,
      assigned: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      total: 0
    };
    for (const task of this.tasks.values()) {
      counts.total++;
      switch (task.status) {
        case 'pending':
          counts.pending++;
          break;
        case 'assigned':
          counts.assigned++;
          break;
        case 'processing':
          counts.processing++;
          break;
        case 'completed':
          counts.completed++;
          break;
        case 'failed':
          counts.failed++;
          break;
      }
    }
    return counts;
  }

  private enforceTaskMemoryLimit(): void {
    while (this.taskOrder.length > this.TASK_MEMORY_LIMIT) {
      const id = this.taskOrder.shift();
      if (id) this.tasks.delete(id);
    }
  }

  // ======== Log Operations ========

  async appendLog(entry: LogEntry): Promise<void> {
    this.logs.push(entry);
    this.logsTotal++;
    if (this.logs.length > this.LOG_MEMORY_LIMIT) {
      this.logs.shift();
    }
    await this.appendLine(LOGS_FILE, entry);
    if (SQLITE_SYNC) sqliteStore.upsertLog(entry);
  }

  getRecentLogs(
    limit: number = 100,
    filter?: {
      level?: LogEntry['level'];
      source?: LogEntry['source'];
    }
  ): LogEntry[] {
    let arr = [...this.logs];
    if (filter?.level) arr = arr.filter((l) => l.level === filter.level);
    if (filter?.source) arr = arr.filter((l) => l.source === filter.source);
    return arr.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  getAllLogsInMemory(): LogEntry[] {
    return [...this.logs];
  }

  // ======== Session Operations (Phase B will use; defined here for unified storage) ========

  async appendSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
    if (!this.sessionOrder.includes(session.id)) {
      this.sessionOrder.push(session.id);
    }
    await this.appendLine(SESSIONS_FILE, { op: 'create', session });
    if (SQLITE_SYNC) sqliteStore.upsertSession(session);
  }

  async updateSession(id: string, patch: Partial<Session>): Promise<boolean> {
    const existing = this.sessions.get(id);
    if (!existing) return false;
    const updated: Session = { ...existing, ...patch, updated_at: Date.now() };
    this.sessions.set(id, updated);
    await this.appendLine(SESSIONS_FILE, { op: 'update', id, patch });
    if (SQLITE_SYNC) sqliteStore.upsertSession(updated);
    return true;
  }

  async deleteSession(id: string): Promise<boolean> {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    const idx = this.sessionOrder.indexOf(id);
    if (idx >= 0) this.sessionOrder.splice(idx, 1);
    await this.appendLine(SESSIONS_FILE, { op: 'delete', id });
    if (SQLITE_SYNC) sqliteStore.deleteSession(id);
    return true;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): Session[] {
    return this.sessionOrder.map((id) => this.sessions.get(id)).filter((s): s is Session => s !== undefined);
  }

  // ======== Stats ========

  getStorageStats() {
    return {
      tasks: {
        count: this.tasks.size,
        file: path.relative(process.cwd(), TASKS_FILE),
        file_size: this.getFileSize(TASKS_FILE),
        file_lines: this.countLines(TASKS_FILE)
      },
      logs: {
        count: this.logs.length,
        total_lines: this.logsTotal,
        file: path.relative(process.cwd(), LOGS_FILE),
        file_size: this.getFileSize(LOGS_FILE),
        file_lines: this.countLines(LOGS_FILE)
      },
      sessions: {
        count: this.sessions.size,
        file: path.relative(process.cwd(), SESSIONS_FILE),
        file_size: this.getFileSize(SESSIONS_FILE),
        file_lines: this.countLines(SESSIONS_FILE)
      },
      writes: {
        pending: this.writeCount > 0 ? 'in_progress' : 'idle',
        count: this.writeCount,
        errors: this.writeErrors
      },
      data_dir: path.relative(process.cwd(), DATA_DIR),
      version: '3.0.0'
    };
  }

  private getFileSize(file: string): number {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  private countLines(file: string): number {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      if (!content) return 0;
      return content.split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  // ======== Export / Import ========

  async exportAll(): Promise<{
    version: string;
    exported_at: number;
    tasks: Task[];
    logs: LogEntry[];
    sessions: Session[];
  }> {
    await this.flush();
    return {
      version: '3.0.0',
      exported_at: Date.now(),
      tasks: this.getAllTasks(),
      logs: this.getAllLogsInMemory(),
      sessions: this.getAllSessions()
    };
  }

  /**
   * Import data by overwriting in-memory state and appending to JSONL files.
   * Existing tasks/logs/sessions are NOT cleared from files (use with care).
   * Returns counts of imported items.
   */
  async importData(data: {
    tasks?: Task[];
    logs?: LogEntry[];
    sessions?: Session[];
  }): Promise<{ tasks: number; logs: number; sessions: number }> {
    let tasksImported = 0;
    let logsImported = 0;
    let sessionsImported = 0;

    if (data.sessions) {
      for (const session of data.sessions) {
        this.appendSession(session);
        sessionsImported++;
      }
    }
    if (data.tasks) {
      for (const task of data.tasks) {
        this.appendTask(task);
        tasksImported++;
      }
    }
    if (data.logs) {
      for (const log of data.logs) {
        this.appendLog(log);
        logsImported++;
      }
    }

    await this.flush();
    return { tasks: tasksImported, logs: logsImported, sessions: sessionsImported };
  }

  /**
   * Wipe all data (in-memory + on disk). Use with caution.
   */
  async wipeAll(): Promise<void> {
    this.tasks.clear();
    this.taskOrder = [];
    this.sessions.clear();
    this.sessionOrder = [];
    this.logs = [];
    this.logsTotal = 0;
    await this.flush();
    for (const file of [TASKS_FILE, LOGS_FILE, SESSIONS_FILE]) {
      try {
        await fs.promises.writeFile(file, '', 'utf-8');
      } catch (e) {
        // ignore
      }
    }
  }

  // ======== Compaction & Backup & Archive ========

  /**
   * Compact JSONL files: rewrite tasks/sessions with only the final state.
   * 将重复的 update/delete 操作合并，减少文件大小。
   */
  async compact(): Promise<{ tasks: number; sessions: number }> {
    await this.flush();
    let tasksCompacted = 0;
    let sessionsCompacted = 0;

    try {
      const taskLines = this.taskOrder
        .map((id) => this.tasks.get(id))
        .filter((t): t is Task => t !== undefined)
        .map((t) => JSON.stringify({ op: 'create', task: t }));
      await fs.promises.writeFile(TASKS_FILE, taskLines.join('\n') + (taskLines.length ? '\n' : ''), 'utf-8');
      tasksCompacted = taskLines.length;
    } catch (e: any) {
      console.error('[storage] compact tasks failed:', e.message);
    }

    try {
      const sessionLines = this.sessionOrder
        .map((id) => this.sessions.get(id))
        .filter((s): s is Session => s !== undefined)
        .map((s) => JSON.stringify({ op: 'create', session: s }));
      await fs.promises.writeFile(SESSIONS_FILE, sessionLines.join('\n') + (sessionLines.length ? '\n' : ''), 'utf-8');
      sessionsCompacted = sessionLines.length;
    } catch (e: any) {
      console.error('[storage] compact sessions failed:', e.message);
    }

    return { tasks: tasksCompacted, sessions: sessionsCompacted };
  }

  /**
   * Backup all data files to a timestamped directory under data/backups.
   */
  async backup(): Promise<{ dir: string; files: string[] }> {
    await this.flush();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(DATA_DIR, 'backups', ts);
    fs.mkdirSync(backupDir, { recursive: true });

    const files: string[] = [];
    const candidates = [
      TASKS_FILE,
      LOGS_FILE,
      SESSIONS_FILE,
      path.join(DATA_DIR, 'kb.jsonl'),
      path.join(DATA_DIR, 'kb_links.jsonl'),
      path.join(DATA_DIR, 'wf.jsonl'),
      path.join(DATA_DIR, 'users.jsonl'),
      path.join(DATA_DIR, 'audit.jsonl'),
      path.join(DATA_DIR, 'system-settings.json'),
      path.join(DATA_DIR, 'models-config.json'),
      path.join(DATA_DIR, 'claw-config.json'),
      path.join(DATA_DIR, 'ai-bridge.db')
    ];

    for (const file of candidates) {
      if (fs.existsSync(file)) {
        const target = path.join(backupDir, path.basename(file));
        fs.copyFileSync(file, target);
        files.push(path.basename(file));
      }
    }

    return { dir: backupDir, files };
  }

  /**
   * Clean up old backups, keeping the most recent `keep` ones.
   */
  cleanupBackups(keep: number = 10): { removed: number; remaining: number } {
    const backupsDir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(backupsDir)) return { removed: 0, remaining: 0 };
    const dirs = fs
      .readdirSync(backupsDir)
      .map((name) => ({ name, stat: fs.statSync(path.join(backupsDir, name)) }))
      .filter((item) => item.stat.isDirectory())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    let removed = 0;
    for (const d of dirs.slice(keep)) {
      try {
        fs.rmSync(path.join(backupsDir, d.name), { recursive: true, force: true });
        removed++;
      } catch (e) {
        console.error(`[storage] remove backup ${d.name} failed:`, e);
      }
    }
    return { removed, remaining: Math.min(dirs.length, keep) };
  }

  /**
   * Archive completed tasks older than `days` into a separate file.
   * 归档后的任务从当前 JSONL 中移除，但保留在 archive 文件中。
   */
  async archiveCompletedTasks(days: number): Promise<{ archived: number; file: string }> {
    await this.flush();
    const cutoff = Date.now() - days * 86400 * 1000;
    const toArchive: Task[] = [];
    const remainingOrder: string[] = [];

    for (const id of this.taskOrder) {
      const t = this.tasks.get(id);
      if (!t) continue;
      if (t.status === 'completed' && t.completed_at && t.completed_at < cutoff) {
        toArchive.push(t);
      } else {
        remainingOrder.push(id);
      }
    }

    if (toArchive.length === 0) return { archived: 0, file: '' };

    const archiveFile = path.join(DATA_DIR, `tasks-archive-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const archiveLines = toArchive.map((t) => JSON.stringify({ op: 'create', task: t }));
    fs.appendFileSync(archiveFile, archiveLines.join('\n') + '\n', 'utf-8');

    this.taskOrder = remainingOrder;
    for (const t of toArchive) {
      this.tasks.delete(t.id);
    }

    await this.compact();
    return { archived: toArchive.length, file: archiveFile };
  }

  // ======== Internal: File I/O ========

  private async appendLine(file: string, data: any): Promise<void> {
    this.writeCount++;
    const line = JSON.stringify(data) + '\n';
    const previous = this.writeQueue;
    const current = previous
      .then(() => fs.promises.appendFile(file, line, 'utf-8'))
      .catch((e) => {
        this.writeErrors++;
        console.error(`[storage] append failed for ${file}:`, e);
        throw e;
      });
    // 保持队列持续前进：即使本次失败也不阻塞后续写入
    this.writeQueue = current.catch(() => {
      /* error already counted & logged */
    });
    return current;
  }

  private loadTasks(): { count: number; corrupted: number } {
    this.tasks.clear();
    this.taskOrder = [];
    if (!fs.existsSync(TASKS_FILE)) return { count: 0, corrupted: 0 };

    const lines = fs
      .readFileSync(TASKS_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (let i = 0; i < lines.length; i++) {
      try {
        const op = JSON.parse(lines[i]) as TaskOp;
        if (op.op === 'create') {
          this.tasks.set(op.task.id, op.task);
          if (!this.taskOrder.includes(op.task.id)) {
            this.taskOrder.push(op.task.id);
          }
        } else if (op.op === 'update') {
          const existing = this.tasks.get(op.id);
          if (existing) {
            this.tasks.set(op.id, { ...existing, ...op.patch });
          }
        } else if (op.op === 'delete') {
          this.tasks.delete(op.id);
          const idx = this.taskOrder.indexOf(op.id);
          if (idx >= 0) this.taskOrder.splice(idx, 1);
        }
      } catch (e) {
        corrupted++;
        this.moveCorruptedLine(TASKS_FILE, i, lines[i]);
      }
    }
    return { count: this.tasks.size, corrupted };
  }

  private loadLogs(): { count: number; corrupted: number } {
    this.logs = [];
    this.logsTotal = 0;
    if (!fs.existsSync(LOGS_FILE)) return { count: 0, corrupted: 0 };

    const lines = fs
      .readFileSync(LOGS_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as LogEntry;
        this.logsTotal++;
        if (this.logs.length < this.LOG_MEMORY_LIMIT) {
          this.logs.push(entry);
        }
      } catch (e) {
        corrupted++;
        this.moveCorruptedLine(LOGS_FILE, i, lines[i]);
      }
    }
    return { count: this.logs.length, corrupted };
  }

  private loadSessions(): { count: number; corrupted: number } {
    this.sessions.clear();
    this.sessionOrder = [];
    if (!fs.existsSync(SESSIONS_FILE)) return { count: 0, corrupted: 0 };

    const lines = fs
      .readFileSync(SESSIONS_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    let corrupted = 0;
    for (let i = 0; i < lines.length; i++) {
      try {
        const op = JSON.parse(lines[i]) as SessionOp;
        if (op.op === 'create') {
          this.sessions.set(op.session.id, op.session);
          if (!this.sessionOrder.includes(op.session.id)) {
            this.sessionOrder.push(op.session.id);
          }
        } else if (op.op === 'update') {
          const existing = this.sessions.get(op.id);
          if (existing) {
            this.sessions.set(op.id, { ...existing, ...op.patch, updated_at: Date.now() });
          }
        } else if (op.op === 'delete') {
          this.sessions.delete(op.id);
          const idx = this.sessionOrder.indexOf(op.id);
          if (idx >= 0) this.sessionOrder.splice(idx, 1);
        }
      } catch (e) {
        corrupted++;
        this.moveCorruptedLine(SESSIONS_FILE, i, lines[i]);
      }
    }
    return { count: this.sessions.size, corrupted };
  }

  private moveCorruptedLine(file: string, lineNum: number, content: string): void {
    try {
      const fileName = path.basename(file);
      const target = path.join(CORRUPTED_DIR, `${fileName}.line${lineNum}.bak`);
      fs.writeFileSync(target, content, 'utf-8');
    } catch (e) {
      // ignore
    }
  }
}

// ======== Singleton ========

export const storage = new Storage();
