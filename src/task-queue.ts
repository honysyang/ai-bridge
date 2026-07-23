/**
 * TaskQueue — 任务队列编排层（v3.1.0 重构版）
 *
 * 设计原则：
 *  1. 持久化交给 storage（append-only JSONL），本类不持有任务主数据
 *  2. 单遍统计（O(N)）取代多次 array.filter().length
 *  3. 显式状态机：所有变更走 transition() 校验非法跳转
 *  4. 长轮询使用 waiter set + 通知，30 秒无任务自动超时
 *  5. 会话上下文（AgentContext）独立内嵌维护，暂不持久化（与 storage 边界保持一致）
 *  6. 对外 API 与 v3.0.0 完全向后兼容
 *
 * 状态机（仅允许以下转换）：
 *   pending    → assigned                  (pollTask)
 *   assigned   → processing                (markProcessing — 预留)
 *   processing → completed | failed        (submitResult)
 *   completed  → pending                   (retryTask)
 *   failed     → pending                   (retryTask)
 */

import {
  Task,
  TaskResult,
  TaskPriority,
  TaskStatus,
  TaskType,
  TaskSource,
  AgentContext,
  QueueStats,
  LogEntry,
  LogLevel,
  LogSource
} from './types.js';
import { storage } from './storage.js';
import { EventEmitter } from 'events';

/** 允许的状态转换表（key=from, value=合法 to 集合） */
const ALLOWED_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  pending:    new Set<TaskStatus>(['assigned']),
  assigned:   new Set<TaskStatus>(['processing', 'completed', 'failed']),
  processing: new Set<TaskStatus>(['completed', 'failed']),
  completed:  new Set<TaskStatus>(['pending']),
  failed:     new Set<TaskStatus>(['pending'])
};

/** 优先级排序权重（数值越小越优先） */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high:   1,
  normal: 2,
  low:    3
};

export class TaskQueue extends EventEmitter {
  // 长轮询等待者集合（最多数十个客户端）
  private waiters: Set<(task: Task | null) => void> = new Set();

  // ID 计数器：构造时基于 storage 现有任务的最大序号初始化，
  // 保证重启后新 ID 不与历史持久化 ID 冲突
  private taskIdCounter: number = 0;
  private logIdCounter: number = 0;

  // 会话上下文：仅内存（与 v3.0.0 设计一致，未持久化）
  private contexts: Map<string, AgentContext> = new Map();

  constructor() {
    super();
    this.addLog('info', 'bridge', 'TaskQueue 已初始化（v3.1.0 状态机版，ID 计数器待 loadAll 后激活）');
  }

  /**
   * 启动时由 server.startServer() 在 storage.loadAll() 之后调用，
   * 基于现有 ID 计算 counter 起点，避免与历史持久化 ID 冲突
   * 例：现有最大 ID 是 task-1784730614024-5，则 counter 起步为 5
   */
  initCounters(): void {
    let max = 0;
    for (const t of storage.getAllTasks()) {
      const m = t.id.match(/^task-(\d+)-(\d+)$/);
      if (m) {
        const n = parseInt(m[2], 10);
        if (n > max) max = n;
      }
    }
    this.taskIdCounter = max;
    this.addLog('info', 'bridge', `TaskQueue 计数器已激活：task#${this.taskIdCounter}`);
  }

  // ============================================================
  //  Task CRUD
  // ============================================================

  /**
   * 新增任务（status 强制 pending）
   * 缺省 session_id 时回落到 'sess-default'
   */
  addTask(taskData: Omit<Task, 'id' | 'status' | 'created_at'>): Task {
    this.taskIdCounter++;
    const fullTask: Task = {
      ...taskData,
      id: this.generateTaskId(),
      status: 'pending',
      created_at: Date.now(),
      session_id: taskData.session_id || 'sess-default'
    };

    storage.appendTask(fullTask);
    this.notifyWaiters(fullTask);
    this.emit('task_added', fullTask);
    this.addLog('info', 'task', `任务创建: ${fullTask.id} (${fullTask.type}/${fullTask.priority})`, {
      task_id: fullTask.id,
      type: fullTask.type,
      priority: fullTask.priority,
      session_id: fullTask.session_id
    });
    return fullTask;
  }

  /** 创建一个手动任务（来源 manual-input） */
  createManualTask(
    content: string,
    type: TaskType = 'reply_message',
    priority: TaskPriority = 'normal'
  ): Task {
    return this.addTask({
      type,
      priority,
      source: 'manual',
      data: { content, from_user: 'manual-input' }
    });
  }

  /** 创建一个聊天任务（来源 chat-user） */
  createChatTask(content: string, fromUser: string = 'chat-user'): Task {
    return this.addTask({
      type: 'chat',
      priority: 'normal',
      source: 'chat',
      data: { content, from_user: fromUser }
    });
  }

  /**
   * 长轮询获取一个 pending 任务并原子地转为 assigned
   * - 若有任务：立即返回（按 priority 升序，再按 created_at 升序）
   * - 若无任务：注册 waiter，最多等待 timeout 毫秒
   */
  async pollTask(timeout: number = 30000): Promise<Task | null> {
    const pending = storage.getRecentTasks(100, { status: 'pending' });
    if (pending.length > 0) {
      pending.sort((a, b) => {
        const dp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        return dp !== 0 ? dp : a.created_at - b.created_at;
      });

      const next = pending[0];
      this.transition(next.id, 'assigned', { assigned_to: 'trae-agent' });
      const updated = storage.getTask(next.id)!;
      this.emit('task_assigned', updated);
      this.addLog('info', 'task', `任务已分配: ${updated.id}`, { task_id: updated.id });
      return updated;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(callback);
        resolve(null);
      }, timeout);

      const callback = (task: Task | null) => {
        clearTimeout(timer);
        this.waiters.delete(callback);
        resolve(task);
      };

      this.waiters.add(callback);
    });
  }

  /**
   * 把任务标记为 processing（预留 API，server.ts 当前未调用）
   * 合法前置状态：assigned
   */
  markProcessing(taskId: string, agentId: string = 'trae-agent'): boolean {
    const ok = this.transition(taskId, 'processing', {
      assigned_to: agentId,
      started_at: Date.now()
    });
    if (ok) {
      const updated = storage.getTask(taskId)!;
      this.emit('task_processing', updated);
      this.addLog('info', 'task', `任务处理中: ${taskId}`, { task_id: taskId });
    }
    return ok;
  }

  /**
   * 提交任务结果
   * status=success → completed；status=partial|failed → failed
   */
  submitResult(result: TaskResult): void {
    const newStatus: TaskStatus = result.status === 'success' ? 'completed' : 'failed';
    const ok = storage.updateTask(result.task_id, {
      status: newStatus,
      result,
      completed_at: result.completed_at
    });

    if (ok) {
      this.emit('task_completed', result);
      this.emit('result', result);
    }

    const logLevel: LogLevel =
      result.status === 'success'  ? 'success' :
      result.status === 'partial'  ? 'warn'    : 'error';
    const statusText =
      result.status === 'success' ? '完成' :
      result.status === 'failed'  ? '失败' : '部分完成';
    this.addLog(logLevel, 'task', `任务${statusText}: ${result.task_id}`, {
      task_id: result.task_id,
      summary: result.result.summary
    });
  }

  /**
   * 重试任务：把 completed/failed 重新置为 pending，并清空 result/started/completed
   */
  retryTask(taskId: string): Task | null {
    const task = storage.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'failed' && task.status !== 'completed') {
      return null;
    }
    storage.updateTask(taskId, {
      status: 'pending',
      result: undefined,
      completed_at: undefined,
      started_at: undefined
    });
    const updated = storage.getTask(taskId)!;
    this.notifyWaiters(updated);
    this.addLog('info', 'task', `任务重试: ${taskId}`, { task_id: taskId });
    this.emit('task_added', updated);
    return updated;
  }

  /** 删除任务 */
  deleteTask(taskId: string): boolean {
    const ok = storage.deleteTask(taskId);
    if (ok) {
      this.addLog('warn', 'task', `任务删除: ${taskId}`, { task_id: taskId });
      this.emit('task_deleted', { id: taskId });
    }
    return ok;
  }

  // ============================================================
  //  Task Queries（薄包装，保持与旧版签名一致）
  // ============================================================

  getTask(id: string): Task | undefined {
    return storage.getTask(id);
  }

  getRecentTasks(
    limit: number = 50,
    filter?: { status?: TaskStatus; type?: TaskType; source?: TaskSource; session_id?: string }
  ): Task[] {
    return storage.getRecentTasks(limit, filter);
  }

  getPendingTasks(): Task[]    { return storage.getAllTasks().filter(t => t.status === 'pending'); }
  getProcessingTasks(): Task[] { return storage.getAllTasks().filter(t => t.status === 'processing'); }
  getCompletedTasks(): Task[]  { return storage.getAllTasks().filter(t => t.status === 'completed'); }
  getFailedTasks(): Task[]     { return storage.getAllTasks().filter(t => t.status === 'failed'); }

  /**
   * 队列统计：单遍 O(N)，由 storage 提供
   * 仅返回 QueueStats 关心的 5 项（按 UI 约定）
   */
  getStats(): QueueStats {
    const c = storage.getCountByStatus();
    return {
      pending: c.pending,
      processing: c.processing,
      completed: c.completed,
      failed: c.failed,
      total: c.total
    };
  }

  // ============================================================
  //  Context（会话上下文，内存）
  // ============================================================

  getContext(sessionId: string): AgentContext | undefined {
    return this.contexts.get(sessionId);
  }

  saveContext(sessionId: string, context: AgentContext): void {
    this.contexts.set(sessionId, context);
  }

  // ============================================================
  //  System Log（薄包装 storage）
  // ============================================================

  addLog(level: LogLevel, source: LogSource, message: string, meta?: Record<string, any>): LogEntry {
    this.logIdCounter++;
    const entry: LogEntry = {
      id: `log-${Date.now()}-${this.logIdCounter}`,
      level,
      source,
      message,
      meta,
      created_at: Date.now()
    };
    storage.appendLog(entry);
    this.emit('log_added', entry);
    return entry;
  }

  getLogs(opts: { level?: LogLevel; source?: LogSource; limit?: number } = {}): LogEntry[] {
    return storage.getRecentLogs(opts.limit ?? 100, {
      level: opts.level,
      source: opts.source
    });
  }

  // ============================================================
  //  Internals
  // ============================================================

  /**
   * 显式状态转换：校验合法性后调用 storage.updateTask
   * 非法转换会被拒绝（return false），并打 warn 日志
   */
  private transition(taskId: string, to: TaskStatus, patch: Record<string, any> = {}): boolean {
    const task = storage.getTask(taskId);
    if (!task) return false;
    const allowed = ALLOWED_TRANSITIONS[task.status];
    if (!allowed || !allowed.has(to)) {
      this.addLog('warn', 'task', `非法状态转换: ${taskId} ${task.status} → ${to}`);
      return false;
    }
    return storage.updateTask(taskId, { status: to, ...patch });
  }

  /** 唤醒所有长轮询等待者；新任务或重试任务到达时调用 */
  private notifyWaiters(task: Task): void {
    for (const waiter of this.waiters) {
      waiter(task);
    }
    this.waiters.clear();
  }

  /** 生成任务 ID：task-{ts}-{counter} */
  private generateTaskId(): string {
    return `task-${Date.now()}-${this.taskIdCounter}`;
  }
}

/** 单例 */
export const taskQueue = new TaskQueue();
