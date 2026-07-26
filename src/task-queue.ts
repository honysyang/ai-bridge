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
import { sessionManager } from './session.js';
import { modelsConfig } from './lib/models-config.js';
import { retrieveAndFormat } from './lib/kb-retriever.js';
import { emitWebhook } from './lib/webhook.js';
import { EventEmitter } from 'events';

/** 允许的状态转换表（key=from, value=合法 to 集合） */
const ALLOWED_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  pending: new Set<TaskStatus>(['assigned']),
  assigned: new Set<TaskStatus>(['processing', 'completed', 'failed']),
  processing: new Set<TaskStatus>(['completed', 'failed']),
  completed: new Set<TaskStatus>(['pending']),
  failed: new Set<TaskStatus>(['pending'])
};

/** 优先级排序权重（数值越小越优先） */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3
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
   * v5.4.0: 自动从 session 继承 project_dir（如果任务本身没指定）
   * v5.4.2: 根据 task_type 解析使用的 provider/model，写入 context.model_routing
   * v5.5.2: 自动 RAG —— 用 task.data.content 检索 KB Top-3 写入 context.kb_retrieval
   */
  async addTask(taskData: Omit<Task, 'id' | 'status' | 'created_at'>): Promise<Task> {
    this.taskIdCounter++;
    const sessionId = taskData.session_id || 'sess-default';
    // v5.4.0: 自动从 session 继承 project_dir
    let projectDir = taskData.project_dir;
    if (!projectDir) {
      const session = sessionManager.getSession(sessionId);
      if (session?.project_dir) {
        projectDir = session.project_dir;
      }
    }
    // v5.4.2: 根据 task_type 解析使用的 provider/model，写入 context.model_routing
    const routing = modelsConfig.resolve(taskData.type);
    // v5.6.0: 自动 RAG 检索（KB Top-3，失败安全，支持向量检索）
    let kbRetrieval: { context: string; items: any[]; hit_count: number; query: string; retrieved_at: number };
    try {
      const result = await retrieveAndFormat(taskData.data?.content || '', { topK: 3, minScore: 1, mode: 'hybrid' });
      kbRetrieval = {
        query: taskData.data?.content || '',
        context: result.context,
        items: result.items.map((it) => ({
          id: it.id,
          title: it.title,
          category_id: it.category_id,
          category_name: it.category_name,
          score: it.score,
          matched_keywords: it.matched_keywords,
          body_preview: it.body_preview
        })),
        hit_count: result.hit_count,
        retrieved_at: Date.now()
      };
    } catch (e) {
      kbRetrieval = { query: '', context: '', items: [], hit_count: 0, retrieved_at: Date.now() };
    }
    const context = {
      ...(taskData.context || {}),
      model_routing: {
        provider: routing.provider,
        model: routing.model,
        source: routing.source,
        resolved_at: Date.now()
      },
      kb_retrieval: kbRetrieval
    };
    const fullTask: Task = {
      ...taskData,
      id: this.generateTaskId(),
      status: 'pending',
      created_at: Date.now(),
      session_id: sessionId,
      project_dir: projectDir,
      context
    };

    await storage.appendTask(fullTask);
    this.notifyWaiters(fullTask);
    this.emit('task_added', fullTask);
    emitWebhook('task.created', {
      id: fullTask.id,
      type: fullTask.type,
      status: fullTask.status,
      session_id: fullTask.session_id
    });
    this.addLog(
      'info',
      'task',
      `任务创建: ${fullTask.id} (${fullTask.type}/${fullTask.priority}) → ${routing.provider}/${routing.model} · KB命中 ${kbRetrieval.hit_count}`,
      {
        task_id: fullTask.id,
        type: fullTask.type,
        priority: fullTask.priority,
        session_id: fullTask.session_id,
        project_dir: fullTask.project_dir,
        routing,
        kb_hit_count: kbRetrieval.hit_count,
        kb_titles: kbRetrieval.items.map((i) => i.title)
      }
    );
    return fullTask;
  }

  /** 创建一个手动任务（来源 manual-input） */
  async createManualTask(
    content: string,
    type: TaskType = 'reply_message',
    priority: TaskPriority = 'normal'
  ): Promise<Task> {
    return this.addTask({
      type,
      priority,
      source: 'manual',
      data: { content, from_user: 'manual-input' }
    });
  }

  /** 创建一个聊天任务（来源 chat-user） */
  async createChatTask(content: string, fromUser: string = 'chat-user'): Promise<Task> {
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
      await this.transition(next.id, 'assigned', { assigned_to: 'trae-agent' });
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
  async markProcessing(taskId: string, agentId: string = 'trae-agent'): Promise<boolean> {
    const ok = await this.transition(taskId, 'processing', {
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
  async submitResult(result: TaskResult): Promise<void> {
    const newStatus: TaskStatus = result.status === 'success' ? 'completed' : 'failed';
    const ok = await storage.updateTask(result.task_id, {
      status: newStatus,
      result,
      completed_at: result.completed_at
    });

    if (ok) {
      if (newStatus === 'completed') {
        this.emit('task_completed', result);
        emitWebhook('task.completed', { task_id: result.task_id, status: newStatus, result: result.result });
      } else {
        this.emit('task_failed', result);
        emitWebhook('task.failed', { task_id: result.task_id, status: newStatus, result: result.result });
      }
      this.emit('result', result);
    }

    const logLevel: LogLevel = result.status === 'success' ? 'success' : result.status === 'partial' ? 'warn' : 'error';
    const statusText = result.status === 'success' ? '完成' : result.status === 'failed' ? '失败' : '部分完成';
    this.addLog(logLevel, 'task', `任务${statusText}: ${result.task_id}`, {
      task_id: result.task_id,
      summary: result.result.summary
    });
  }

  /**
   * 重试任务：把 completed/failed 重新置为 pending，并清空 result/started/completed
   */
  async retryTask(taskId: string): Promise<Task | null> {
    const task = storage.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'failed' && task.status !== 'completed') {
      return null;
    }
    await storage.updateTask(taskId, {
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

  /**
   * v5.4.2: 撤回任务（undo）—— 把 completed/failed 的任务回退到 pending
   * 与 retryTask 的区别：会保存原 result 到 context.undo_history，可恢复
   */
  async undoTask(taskId: string): Promise<{ task: Task; undone: boolean; history: any[] } | null> {
    const task = storage.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'failed' && task.status !== 'completed') {
      return null;
    }
    // 收集历史
    const prevHistory: any[] = (task.context?.undo_history as any[]) || [];
    prevHistory.push({
      undone_at: Date.now(),
      prev_status: task.status,
      prev_result: task.result,
      prev_started_at: task.started_at,
      prev_completed_at: task.completed_at
    });
    // 保留最近 5 次历史
    const history = prevHistory.slice(-5);

    await storage.updateTask(taskId, {
      status: 'pending',
      result: undefined,
      completed_at: undefined,
      started_at: undefined,
      context: { ...(task.context || {}), undo_history: history }
    });
    const updated = storage.getTask(taskId)!;
    this.notifyWaiters(updated);
    this.addLog('info', 'task', `任务撤回: ${taskId} (历史 ${history.length} 条)`, {
      task_id: taskId,
      history_size: history.length
    });
    this.emit('task_added', updated);
    return { task: updated, undone: true, history };
  }

  /**
   * v5.4.2: 恢复任务（restore）—— 从 undo_history 中恢复某次的结果
   */
  async restoreTask(taskId: string, historyIndex?: number): Promise<Task | null> {
    const task = storage.getTask(taskId);
    if (!task) return null;
    const history: any[] = (task.context?.undo_history as any[]) || [];
    if (history.length === 0) return null;
    const idx = historyIndex !== undefined ? historyIndex : history.length - 1;
    const item = history[idx];
    if (!item) return null;
    // 弹出该条
    const newHistory = history.filter((_, i) => i !== idx);
    await storage.updateTask(taskId, {
      status: item.prev_status || 'completed',
      result: item.prev_result,
      completed_at: item.prev_completed_at,
      started_at: item.prev_started_at,
      context: { ...(task.context || {}), undo_history: newHistory }
    });
    const updated = storage.getTask(taskId)!;
    this.addLog('info', 'task', `任务恢复: ${taskId} → ${item.prev_status}`, { task_id: taskId });
    return updated;
  }

  /**
   * v5.4.3: 创建补充对话任务（followup）—— 基于已有任务，附带 parent_task 上下文，
   * 让 agent 在执行时能参考原任务的完整 result/evidence，从而做出更精准的回复。
   *
   * 设计要点：
   *  - 继承 parent 的 session_id、project_dir（保证 cwd 一致）
   *  - 继承 parent 的 type（也可显式覆盖）
   *  - 默认 priority = parent.priority
   *  - context.parent_task_id 指向原任务
   *  - context.parent_context 汇总原任务的 result 关键字段
   *  - data.from_user = 'followup'，data.extra.parent_task_id 便于前端溯源
   */
  async createFollowupTask(opts: {
    parent_task_id: string;
    content: string;
    type?: TaskType;
    priority?: TaskPriority;
    source?: TaskSource;
  }): Promise<{ task: Task; parent: Task } | null> {
    const parent = storage.getTask(opts.parent_task_id);
    if (!parent) return null;
    if (!opts.content || !opts.content.trim()) return null;

    const sessionId = parent.session_id || 'sess-default';
    // project_dir 已在 addTask 内从 session 继承，这里显式传以确保万无一失
    const projectDir = parent.project_dir;

    const parentSummary = parent.result?.result?.summary || '';
    const parentDetails = parent.result?.result?.details || '';
    const parentType = opts.type || parent.type;
    const parentPriority = opts.priority || parent.priority;
    const parentSource: TaskSource = opts.source || (parent.source === 'wechat' ? 'wechat' : 'manual');

    const context: Record<string, any> = {
      parent_task_id: parent.id,
      parent_context: {
        type: parent.type,
        status: parent.status,
        priority: parent.priority,
        content: parent.data?.content || '',
        summary: parentSummary,
        details: parentDetails,
        project_dir: projectDir || null,
        session_id: sessionId
      },
      followup_at: Date.now()
    };

    const followup = await this.addTask({
      type: parentType,
      priority: parentPriority,
      source: parentSource,
      session_id: sessionId,
      project_dir: projectDir,
      data: {
        content: opts.content.trim(),
        from_user: 'followup',
        extra: { parent_task_id: parent.id }
      },
      context
    } as any);

    this.addLog('info', 'task', `补充任务创建: ${followup.id} ← ${parent.id}`, {
      task_id: followup.id,
      parent_task_id: parent.id,
      type: followup.type,
      priority: followup.priority,
      session_id: followup.session_id
    });

    return { task: followup, parent };
  }

  /** 删除任务 */
  async deleteTask(taskId: string): Promise<boolean> {
    const ok = await storage.deleteTask(taskId);
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
    filter?: { status?: TaskStatus; type?: TaskType; source?: TaskSource; session_id?: string; offset?: number }
  ): Task[] {
    return storage.getRecentTasks(limit, filter);
  }

  countTasks(filter?: { status?: TaskStatus; type?: TaskType; source?: TaskSource; session_id?: string }): number {
    return storage.countTasks(filter);
  }

  getPendingTasks(): Task[] {
    return storage.getAllTasks().filter((t) => t.status === 'pending');
  }
  getProcessingTasks(): Task[] {
    return storage.getAllTasks().filter((t) => t.status === 'processing');
  }
  getCompletedTasks(): Task[] {
    return storage.getAllTasks().filter((t) => t.status === 'completed');
  }
  getFailedTasks(): Task[] {
    return storage.getAllTasks().filter((t) => t.status === 'failed');
  }

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

  async addLog(level: LogLevel, source: LogSource, message: string, meta?: Record<string, any>): Promise<LogEntry> {
    this.logIdCounter++;
    const entry: LogEntry = {
      id: `log-${Date.now()}-${this.logIdCounter}`,
      level,
      source,
      message,
      meta,
      created_at: Date.now()
    };
    try {
      await storage.appendLog(entry);
    } catch (e) {
      // 日志写入失败不应阻塞业务主流程
      console.error('[taskQueue] log append failed:', e);
    }
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
  private async transition(taskId: string, to: TaskStatus, patch: Record<string, any> = {}): Promise<boolean> {
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
