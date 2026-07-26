// ======== 微信消息桥接（v4.0.0） ========
//
// 职责：
// 1. 接收 adapter.on('message') → 去重 → 查/建 session → taskQueue.addTask
// 2. 监听 taskQueue.on('task_completed') → 若 source=wechat 则 adapter.sendText
// 3. 维护 per-wxid 串行队列：保证同一用户的请求-回复 1:1 有序
// 4. 失败时把"待回复"落到 storage，Web UI 可查询，避免静默丢失
// 5. 会话静默期后自动发"任务总结"：聚合该 wxid 最近一批任务的 Q&A
//
// v4.2 改进：请求-回答一一对应 + 失败可观测
// v4.3 改进：会话级总结（用户停发后自动汇总）

import { ClawAdapter } from './adapter.js';
import { MessageDedup } from './dedup.js';
import { clawConfig } from './config.js';
import { WeChatMessage } from './types.js';
import { taskQueue } from '../task-queue.js';
import { sessionManager } from '../session.js';
import { storage } from '../storage.js';
import { TaskResult, Task } from '../types.js';
import { retrieveAndFormat } from '../lib/kb-retriever.js';
import { emitWebhook } from '../lib/webhook.js';

interface PendingReply {
  task: Task;
  result: TaskResult;
  enqueued_at: number;
  attempts: number;
}

interface SummaryTracker {
  wxid: string;
  lastTaskAt: number; // 最后一条 task 完成时间
  lastMessageAt: number; // 用户最后一条入站消息时间
  summaryTimer?: NodeJS.Timeout; // 静默期定时器
  lastSummaryAt?: number; // 上次总结发送时间
  pendingSummaryText?: string; // 准备发送的总结文本
}

export class MessageBridge {
  private dedup: MessageDedup;
  private taskCompletedHandler?: (result: TaskResult) => void;
  // 每 wxid 独立队列 + 串行 worker，避免并发 sendText 导致乱序
  private outgoingQueues: Map<string, PendingReply[]> = new Map();
  private workersRunning: Set<string> = new Set();
  // 失败兜底：写回 storage 标记 failed_reply，Web UI 可读
  private readonly FAILED_REPLY_TTL_MS = 24 * 3600 * 1000;
  // 会话总结（v4.3）
  private summaryTrackers: Map<string, SummaryTracker> = new Map();
  private readonly DEFAULT_QUIET_MS = 60000; // 静默 60s 触发总结
  private readonly MAX_SUMMARY_TASKS = 10; // 总结最多聚合 10 条
  private readonly MIN_SUMMARY_GAP_MS = 120000; // 同一 wxid 至少 2 分钟才能再次总结

  constructor(private adapter: ClawAdapter) {
    this.dedup = new MessageDedup();

    // 微信消息 → 任务
    this.adapter.on('message', (msg) =>
      this.handleIncoming(msg).catch((e) =>
        taskQueue.addLog('error', 'bridge', `[incoming] 处理失败: ${(e as Error).message}`)
      )
    );

    // 任务完成 → 回微信
    this.taskCompletedHandler = (result) => {
      this.handleOutgoing(result).catch((e) =>
        taskQueue.addLog('error', 'bridge', `[outgoing] 处理失败: ${(e as Error).message}`)
      );
    };
    taskQueue.on('task_completed', this.taskCompletedHandler);

    // adapter 错误日志
    this.adapter.on('error', (err) => {
      // v5.2.1: 长轮询 abort 是正常的瞬态情况，降级到 warn 而非 error
      const msg = err.message || '';
      const isAbort = /aborted|AbortError/i.test(msg);
      taskQueue.addLog(isAbort ? 'warn' : 'error', 'bridge', `[claw] ${msg}`);
    });
  }

  /**
   * 处理入站微信消息
   * v5.5.2: 同步执行 KB 预检索（写入 context.wechat_kb_hits）
   *         任务自身的 context.kb_retrieval 会在 addTask 中再次自动注入
   */
  private async handleIncoming(msg: WeChatMessage): Promise<void> {
    // 1. 去重
    const cfg = clawConfig.get();
    if (this.dedup.has(msg.msg_id, cfg.message_dedup_ttl_ms)) {
      taskQueue.addLog('debug', 'bridge', `微信消息重复，跳过: ${msg.msg_id}`);
      return;
    }

    // 2. 查/建 session（按 wxid）
    const session = await this.getOrCreateWechatSession(msg);

    // 3. v5.5.2: 预检索 KB（失败安全，try-catch 吞掉异常）
    let kbHits: { count: number; titles: string[]; context: string } = { count: 0, titles: [], context: '' };
    try {
      const result = await retrieveAndFormat(msg.content || '', { topK: 3, minScore: 1, mode: 'hybrid' });
      kbHits = {
        count: result.hit_count,
        titles: result.items.map((i) => i.title),
        context: result.context
      };
    } catch (e) {
      taskQueue.addLog('debug', 'bridge', `微信消息 KB 预检索失败: ${(e as Error).message}`);
    }

    // 4. 创建任务（addTask 内部还会再做一次自动 RAG，结果写入 context.kb_retrieval）
    const task = await taskQueue.addTask({
      type: 'reply_message',
      priority: 'normal',
      source: 'wechat',
      session_id: session.id,
      data: {
        from_user: msg.from_user,
        content: msg.content
      },
      context: {
        wechat_msg_id: msg.msg_id,
        wechat_wxid: msg.wxid,
        wechat_type: msg.type,
        wechat_room: msg.room_wxid,
        wechat_timestamp: msg.timestamp,
        // v5.5.2: 微信专属 KB 命中（与 addTask 中的 kb_retrieval 互补）
        wechat_kb_hits: {
          count: kbHits.count,
          titles: kbHits.titles,
          context: kbHits.context,
          retrieved_at: Date.now()
        }
      }
    } as any);

    // 5. 刷新会话时间
    await sessionManager.touchSession(session.id);

    // 6. 更新总结 tracker：标记用户最新消息时间，并取消挂起的总结
    this.recordIncomingMessage(msg.wxid);

    const kbSummary =
      kbHits.count > 0
        ? ` · KB命中 ${kbHits.count} 条 [${kbHits.titles.slice(0, 2).join(', ')}${kbHits.titles.length > 2 ? '…' : ''}]`
        : ' · KB无命中';
    taskQueue.addLog(
      'info',
      'task',
      `微信消息入队: ${msg.from_user} → ${task.id} (session=${session.id})${kbSummary}`,
      {
        task_id: task.id,
        session_id: session.id,
        wechat_msg_id: msg.msg_id,
        kb_hit_count: kbHits.count,
        kb_titles: kbHits.titles
      }
    );
    emitWebhook('claw.message', {
      wxid: msg.wxid,
      from_user: msg.from_user,
      content_preview: (msg.content || '').slice(0, 200),
      task_id: task.id
    });
  }

  /**
   * 处理出站（任务完成 → 微信回复）
   * - 不直接 sendText，而是入队 + 触发串行 worker
   * - 串行化保证同一 wxid 的多条回复按任务完成顺序投递
   */
  private async handleOutgoing(result: TaskResult): Promise<void> {
    const cfg = clawConfig.get();
    if (!cfg.auto_reply) {
      taskQueue.addLog('debug', 'bridge', `auto_reply=false，跳过 ${result.task_id}`);
      return;
    }

    const task = taskQueue.getTask(result.task_id);
    if (!task || task.source !== 'wechat') return;

    const wxid = (task.context as any)?.wechat_wxid;
    if (!wxid) return;

    const summary = result.result?.summary || '';
    if (!summary) {
      taskQueue.addLog('warn', 'bridge', `任务 ${result.task_id} 无 summary，跳过微信回复`);
      await this.markReplyFailed(task, 'empty_summary');
      return;
    }

    // 入队（按任务完成顺序，自然有序）
    const queue = this.outgoingQueues.get(wxid) || [];
    queue.push({ task, result, enqueued_at: Date.now(), attempts: 0 });
    this.outgoingQueues.set(wxid, queue);

    taskQueue.addLog('info', 'bridge', `微信回复入队: ${task.id} (queue_len=${queue.length}, wxid=${wxid})`, {
      task_id: task.id,
      wechat_wxid: wxid,
      queue_len: queue.length
    });

    // 触发 worker（非阻塞）
    this.scheduleWorker(wxid);

    // 任务完成：调度会话总结（静默期后）
    this.scheduleSummary(wxid);
  }

  /**
   * 串行 worker：每个 wxid 同时只跑一个
   */
  private scheduleWorker(wxid: string): void {
    if (this.workersRunning.has(wxid)) return;
    this.workersRunning.add(wxid);

    // 异步执行，不阻塞事件循环
    setImmediate(() => this.runWorker(wxid));
  }

  private async runWorker(wxid: string): Promise<void> {
    try {
      while (true) {
        const queue = this.outgoingQueues.get(wxid);
        if (!queue || queue.length === 0) break;

        const item = queue.shift()!;
        item.attempts++;

        const summary = item.result.result.summary;
        // 关联原问题：把 task.data.content 前 30 字做前缀，便于用户对照
        const originalQ = (item.task.data?.content || '').slice(0, 30);
        const replyText = originalQ
          ? `「${originalQ}${item.task.data?.content && item.task.data.content.length > 30 ? '…' : ''}」\n${summary}`
          : summary;

        try {
          const msgId = await this.adapter.sendText(wxid, replyText);
          taskQueue.addLog('success', 'task', `微信回复成功: ${item.task.id} → ${wxid} (msgId=${msgId})`, {
            task_id: item.task.id,
            wechat_wxid: wxid,
            reply_msg_id: msgId,
            original_q: originalQ
          });
          // v5.1.1: 持久化发送状态到 task context
          await this.markReplySent(item.task, msgId, originalQ);
        } catch (err: any) {
          taskQueue.addLog('error', 'bridge', `微信回复失败: ${item.task.id} → ${wxid}: ${err.message}`, {
            task_id: item.task.id,
            wechat_wxid: wxid,
            attempts: item.attempts
          });

          // 失败兜底：标记 task 失败，Web UI 可查（避免静默丢失）
          await this.markReplyFailed(item.task, err.message || 'send_failed');

          // 重试：最多 2 次，指数退避
          if (item.attempts < 2) {
            const delay = 1000 * Math.pow(2, item.attempts); // 1s, 2s
            setTimeout(() => {
              const q = this.outgoingQueues.get(wxid) || [];
              q.unshift(item); // 放回队首
              this.outgoingQueues.set(wxid, q);
              this.scheduleWorker(wxid);
            }, delay);
          }
        }
      }
    } finally {
      this.workersRunning.delete(wxid);
    }
  }

  /**
   * 失败兜底：把"应该回复但没回"标记到 task 上，Web UI 可查
   */
  private async markReplyFailed(task: Task, reason: string): Promise<void> {
    try {
      await storage.updateTask(task.id, {
        context: {
          ...((task.context as any) || {}),
          wechat_reply: {
            ...((task.context as any)?.wechat_reply || {}),
            status: 'failed',
            reason,
            failed_at: Date.now()
          }
        }
      } as any);
    } catch (e) {
      taskQueue.addLog('error', 'bridge', `markReplyFailed 失败: ${(e as Error).message}`);
    }
  }

  /**
   * 成功标记：把"已成功发送"写到 task context，Web UI 可查
   * v5.1.1 新增：之前只有失败标记，成功未持久化，导致用户看不到状态
   */
  private async markReplySent(task: Task, msgId: string, originalQ: string): Promise<void> {
    try {
      await storage.updateTask(task.id, {
        context: {
          ...((task.context as any) || {}),
          wechat_reply: {
            ...((task.context as any)?.wechat_reply || {}),
            status: 'sent',
            msg_id: msgId,
            sent_at: Date.now(),
            original_q: originalQ
          }
        }
      } as any);
    } catch (e) {
      taskQueue.addLog('warn', 'bridge', `markReplySent 失败: ${(e as Error).message}`);
    }
  }

  // ============== v4.3 会话总结 ==============

  /**
   * 记录用户入站消息：刷新 lastMessageAt、取消挂起的总结
   */
  private recordIncomingMessage(wxid: string): void {
    let tracker = this.summaryTrackers.get(wxid);
    if (!tracker) {
      tracker = { wxid, lastTaskAt: 0, lastMessageAt: 0 };
      this.summaryTrackers.set(wxid, tracker);
    }
    tracker.lastMessageAt = Date.now();
    // 用户在说话 → 取消挂起的总结（避免打断对话）
    if (tracker.summaryTimer) {
      clearTimeout(tracker.summaryTimer);
      tracker.summaryTimer = undefined;
      taskQueue.addLog('debug', 'bridge', `[summary] 取消 ${wxid} 挂起总结（用户新消息）`);
    }
  }

  /**
   * 调度会话总结：静默期后触发
   */
  private scheduleSummary(wxid: string): void {
    let tracker = this.summaryTrackers.get(wxid);
    if (!tracker) {
      tracker = { wxid, lastTaskAt: 0, lastMessageAt: 0 };
      this.summaryTrackers.set(wxid, tracker);
    }
    tracker.lastTaskAt = Date.now();

    // 防抖：取消旧 timer，挂新 timer
    if (tracker.summaryTimer) {
      clearTimeout(tracker.summaryTimer);
    }
    tracker.summaryTimer = setTimeout(() => {
      tracker!.summaryTimer = undefined;
      this.maybeSendSummary(wxid).catch((err) => {
        taskQueue.addLog('error', 'bridge', `[summary] ${wxid} 失败: ${err.message}`);
      });
    }, this.DEFAULT_QUIET_MS);
  }

  /**
   * 检查是否可发总结，发则发
   * 条件：① 静默期已到 ② 队列无积压 ③ 上次总结已过 MIN_SUMMARY_GAP_MS ④ 有可总结内容
   */
  private async maybeSendSummary(wxid: string): Promise<void> {
    const tracker = this.summaryTrackers.get(wxid);
    if (!tracker) return;

    // 条件①：用户已经 N 秒没说话
    const quietFor = Date.now() - tracker.lastMessageAt;
    if (quietFor < this.DEFAULT_QUIET_MS) {
      // 还没到静默期，再排一次
      this.scheduleSummary(wxid);
      return;
    }

    // 条件②：worker 队列为空
    if ((this.outgoingQueues.get(wxid) || []).length > 0 || this.workersRunning.has(wxid)) {
      taskQueue.addLog('debug', 'bridge', `[summary] ${wxid} 队列未空，延后总结`);
      this.scheduleSummary(wxid);
      return;
    }

    // 条件③：距离上次总结至少 N ms
    if (tracker.lastSummaryAt && Date.now() - tracker.lastSummaryAt < this.MIN_SUMMARY_GAP_MS) {
      taskQueue.addLog('debug', 'bridge', `[summary] ${wxid} 总结冷却中`);
      return;
    }

    // 找该 wxid 的 session
    const sessions = sessionManager.listSessions();
    const session = sessions.find((s) => (s.meta as any)?.wechat_wxid === wxid);
    if (!session) return;

    // 拉该 session 最近 N 条 task（最多 1h 内）
    const since = Date.now() - 3600 * 1000;
    const tasks = taskQueue
      .getRecentTasks(this.MAX_SUMMARY_TASKS, { session_id: session.id })
      .filter((t) => t.completed_at && t.completed_at >= since)
      .sort((a, b) => (a.completed_at || 0) - (b.completed_at || 0));

    if (tasks.length === 0) return;

    // 组装总结
    const summaryText = this.composeSummary(wxid, tasks);
    if (!summaryText) return;

    // 发送（走串行 worker）
    tracker.lastSummaryAt = Date.now();
    try {
      const msgId = await this.adapter.sendText(wxid, summaryText);
      taskQueue.addLog('success', 'task', `微信会话总结: ${wxid} (${tasks.length} 任务, msgId=${msgId})`, {
        wechat_wxid: wxid,
        summary_task_count: tasks.length,
        reply_msg_id: msgId
      });

      // 标记总结已发（写到每个 task context）
      for (const t of tasks) {
        try {
          await storage.updateTask(t.id, {
            context: {
              ...((t.context as any) || {}),
              wechat_summary: { sent_at: Date.now(), session_id: session.id }
            }
          } as any);
        } catch {
          /* ignore */
        }
      }
    } catch (err: any) {
      taskQueue.addLog('error', 'bridge', `[summary] 发送失败: ${err.message}`);
    }
  }

  /**
   * 组装总结文本
   */
  private composeSummary(wxid: string, tasks: Task[]): string {
    const lines: string[] = [];
    lines.push(`📋 任务总结（共 ${tasks.length} 条）`);
    lines.push('');

    const success = tasks.filter((t) => t.result?.status === 'success').length;
    const failed = tasks.filter((t) => t.result?.status === 'failed').length;
    const lines2 = [];
    if (success > 0) lines2.push(`✅ ${success} 成功`);
    if (failed > 0) lines2.push(`❌ ${failed} 失败`);
    if (lines2.length > 0) {
      lines.push(lines2.join('  '));
      lines.push('');
    }

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const q = (t.data?.content || '').slice(0, 25);
      const dots = t.data?.content && t.data.content.length > 25 ? '…' : '';
      const icon = t.result?.status === 'success' ? '✅' : t.result?.status === 'failed' ? '❌' : '⏳';
      const a = (t.result?.result?.summary || '(无回复)').slice(0, 35);
      const aDots = (t.result?.result?.summary || '').length > 35 ? '…' : '';
      lines.push(`${i + 1}. ${icon} 「${q}${dots}」`);
      lines.push(`   → ${a}${aDots}`);
    }

    lines.push('');
    lines.push('如需详细某条任务，回复"详情 #编号"');

    return lines.join('\n');
  }

  /**
   * 手动触发总结（API 用）
   */
  async triggerSummaryNow(wxid: string): Promise<{ sent: boolean; task_count: number; text?: string }> {
    const sessions = sessionManager.listSessions();
    const session = sessions.find((s) => (s.meta as any)?.wechat_wxid === wxid);
    if (!session) return { sent: false, task_count: 0 };

    const tasks = taskQueue
      .getRecentTasks(this.MAX_SUMMARY_TASKS, { session_id: session.id })
      .filter((t) => t.completed_at)
      .sort((a, b) => (a.completed_at || 0) - (b.completed_at || 0));

    if (tasks.length === 0) return { sent: false, task_count: 0 };

    const text = this.composeSummary(wxid, tasks);
    try {
      await this.adapter.sendText(wxid, text);
      return { sent: true, task_count: tasks.length, text };
    } catch (err: any) {
      taskQueue.addLog('error', 'bridge', `[summary] 手动触发失败: ${err.message}`);
      return { sent: false, task_count: tasks.length, text };
    }
  }

  /**
   * 查/建微信会话
   */
  private async getOrCreateWechatSession(msg: WeChatMessage): Promise<any> {
    const allSessions = sessionManager.listSessions();
    const found = allSessions.find((s) => (s.meta as any)?.wechat_wxid === msg.wxid);
    if (found) return found;

    const name = msg.room_wxid ? `微信群 · ${msg.from_user}` : `微信 · ${msg.from_user}`;

    return await sessionManager.createSession({
      name,
      description: `自动创建（${msg.wxid}）`,
      meta: {
        wechat_wxid: msg.wxid,
        wechat_type: msg.room_wxid ? 'group' : 'friend',
        wechat_room: msg.room_wxid
      }
    });
  }

  /**
   * 队列状态（用于 API 暴露，方便排查）
   */
  getQueueStatus(): { wxid: string; pending: number; running: boolean }[] {
    const out: { wxid: string; pending: number; running: boolean }[] = [];
    for (const [wxid, queue] of this.outgoingQueues.entries()) {
      out.push({
        wxid,
        pending: queue.length,
        running: this.workersRunning.has(wxid)
      });
    }
    return out;
  }

  /**
   * 总结状态（v4.3）
   */
  getSummaryStatus(): {
    wxid: string;
    quiet_for_ms: number;
    last_task_at: number;
    last_summary_at: number;
    pending: boolean;
  }[] {
    const out = [];
    const now = Date.now();
    for (const [wxid, t] of this.summaryTrackers.entries()) {
      out.push({
        wxid,
        quiet_for_ms: t.lastMessageAt > 0 ? now - t.lastMessageAt : -1,
        last_task_at: t.lastTaskAt,
        last_summary_at: t.lastSummaryAt || 0,
        pending: !!t.summaryTimer
      });
    }
    return out;
  }

  /**
   * 清理
   */
  destroy(): void {
    if (this.taskCompletedHandler) {
      taskQueue.off('task_completed', this.taskCompletedHandler);
      this.taskCompletedHandler = undefined;
    }
    this.outgoingQueues.clear();
    this.workersRunning.clear();
    for (const t of this.summaryTrackers.values()) {
      if (t.summaryTimer) clearTimeout(t.summaryTimer);
    }
    this.summaryTrackers.clear();
    this.dedup.clear();
  }
}
