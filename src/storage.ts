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

const DATA_DIR = path.join(process.cwd(), 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.jsonl');
const LOGS_FILE = path.join(DATA_DIR, 'logs.jsonl');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');
const CORRUPTED_DIR = path.join(DATA_DIR, '.corrupted');

// ======== Op Types ========

export type TaskOp =
  | { op: 'create'; task: Task }
  | { op: 'update'; id: string; patch: Partial<Task> }
  | { op: 'delete'; id: string };

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

  appendTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.taskOrder.push(task.id);
    this.enforceTaskMemoryLimit();
    this.appendLine(TASKS_FILE, { op: 'create', task });
  }

  updateTask(id: string, patch: Partial<Task>): boolean {
    const existing = this.tasks.get(id);
    if (!existing) return false;
    const updated: Task = { ...existing, ...patch };
    this.tasks.set(id, updated);
    this.appendLine(TASKS_FILE, { op: 'update', id, patch });
    return true;
  }

  deleteTask(id: string): boolean {
    if (!this.tasks.has(id)) return false;
    this.tasks.delete(id);
    const idx = this.taskOrder.indexOf(id);
    if (idx >= 0) this.taskOrder.splice(idx, 1);
    this.appendLine(TASKS_FILE, { op: 'delete', id });
    return true;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return this.taskOrder
      .map(id => this.tasks.get(id))
      .filter((t): t is Task => t !== undefined);
  }

  getRecentTasks(limit: number = 50, filter?: {
    status?: Task['status'];
    type?: Task['type'];
    source?: Task['source'];
    session_id?: string;
  }): Task[] {
    let arr = this.getAllTasks();
    if (filter?.status) {
      // v5.1.1: 支持多状态过滤（逗号分隔），如 status=assigned,processing
      const statuses = String(filter.status).split(',').map(s => s.trim()).filter(Boolean);
      arr = statuses.length > 1
        ? arr.filter(t => statuses.includes(t.status))
        : arr.filter(t => t.status === filter!.status);
    }
    if (filter?.type) arr = arr.filter(t => t.type === filter.type);
    if (filter?.source) arr = arr.filter(t => t.source === filter.source);
    if (filter?.session_id) arr = arr.filter(t => (t as any).session_id === filter.session_id);
    return arr.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
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
        case 'pending':    counts.pending++;    break;
        case 'assigned':   counts.assigned++;   break;
        case 'processing': counts.processing++; break;
        case 'completed':  counts.completed++;  break;
        case 'failed':     counts.failed++;     break;
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

  appendLog(entry: LogEntry): void {
    this.logs.push(entry);
    this.logsTotal++;
    if (this.logs.length > this.LOG_MEMORY_LIMIT) {
      this.logs.shift();
    }
    this.appendLine(LOGS_FILE, entry);
  }

  getRecentLogs(limit: number = 100, filter?: {
    level?: LogEntry['level'];
    source?: LogEntry['source'];
  }): LogEntry[] {
    let arr = [...this.logs];
    if (filter?.level) arr = arr.filter(l => l.level === filter.level);
    if (filter?.source) arr = arr.filter(l => l.source === filter.source);
    return arr.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  getAllLogsInMemory(): LogEntry[] {
    return [...this.logs];
  }

  // ======== Session Operations (Phase B will use; defined here for unified storage) ========

  appendSession(session: Session): void {
    this.sessions.set(session.id, session);
    if (!this.sessionOrder.includes(session.id)) {
      this.sessionOrder.push(session.id);
    }
    this.appendLine(SESSIONS_FILE, { op: 'create', session });
  }

  updateSession(id: string, patch: Partial<Session>): boolean {
    const existing = this.sessions.get(id);
    if (!existing) return false;
    const updated: Session = { ...existing, ...patch, updated_at: Date.now() };
    this.sessions.set(id, updated);
    this.appendLine(SESSIONS_FILE, { op: 'update', id, patch });
    return true;
  }

  deleteSession(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    const idx = this.sessionOrder.indexOf(id);
    if (idx >= 0) this.sessionOrder.splice(idx, 1);
    this.appendLine(SESSIONS_FILE, { op: 'delete', id });
    return true;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): Session[] {
    return this.sessionOrder
      .map(id => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined);
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
      return content.split('\n').filter(l => l.trim()).length;
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

  // ======== Internal: File I/O ========

  private appendLine(file: string, data: any): void {
    this.writeCount++;
    const line = JSON.stringify(data) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => fs.promises.appendFile(file, line, 'utf-8'))
      .catch(e => {
        this.writeErrors++;
        console.error(`[storage] append failed for ${file}:`, e);
      });
  }

  private loadTasks(): { count: number; corrupted: number } {
    this.tasks.clear();
    this.taskOrder = [];
    if (!fs.existsSync(TASKS_FILE)) return { count: 0, corrupted: 0 };

    const lines = fs.readFileSync(TASKS_FILE, 'utf-8').split('\n').filter(l => l.trim());
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

    const lines = fs.readFileSync(LOGS_FILE, 'utf-8').split('\n').filter(l => l.trim());
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

    const lines = fs.readFileSync(SESSIONS_FILE, 'utf-8').split('\n').filter(l => l.trim());
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
