// ======== 微信空闲提醒（v5.5.0 新增） ========
//
// 职责：
// 1. 周期性检查所有活跃微信 wxid 的"最后活动时间"
// 2. 满足"工作时间 + 已静默 N 分钟 + 冷却期过"三条件时，发送提醒
// 3. 提醒内容可配置：每日数据摘要 / 任务总结 / 二者结合
// 4. 走 adapter.sendText，与现有任务回复同源（不绕过 outgoingQueues，
//    但因 idle 不是任务完成事件，直接调 sendText，并在 log 中标注）
//
// 设计原则：
// - 时间窗口判断：先排除"休息时间"，再要求"工作时间"（双层过滤）
// - 静默时间 = max(lastTaskAt, lastMessageAt) - now
// - 冷却 = 每个 wxid 独立 lastSentAt Map，避免重复打扰
// - 失败重试 2 次（同 reply 行为），失败不写入 lastSentAt（下次可重试）

import { ClawAdapter } from './adapter.js';
import { clawConfig } from './config.js';
import { TimeWindow, WeChatMessage } from './types.js';
import { taskQueue } from '../task-queue.js';
import { sessionManager } from '../session.js';
import { storage } from '../storage.js';
import { Task } from '../types.js';

interface ActiveWxid {
  wxid: string;
  sessionId: string;
  lastTaskAt: number;        // 该 wxid 最后一条 task 完成时间（ms）
  lastMessageAt: number;     // 该 wxid 最后一条入站消息时间（ms）
}

export interface IdleStatus {
  enabled: boolean;
  check_interval_min: number;
  min_quiet_min: number;
  work_hours: TimeWindow;
  rest_hours: TimeWindow;
  message_types: string[];
  cooldown_min: number;
  in_work_window: boolean;
  active_wxid_count: number;
  last_tick_at: number;
  last_sent_at: number;
  last_sent_wxid?: string;
  last_sent_status?: 'success' | 'failed' | 'skipped';
  last_error?: string;
  cooldowns: Array<{ wxid: string; last_sent_at: number; next_avail_at: number }>;
}

export class IdleNotifier {
  private timer?: NodeJS.Timeout;
  private lastSentAt: Map<string, number> = new Map();   // wxid → last sent ts
  private lastTickAt: number = 0;
  private lastSent: { wxid?: string; at: number; status?: 'success' | 'failed' | 'skipped'; error?: string } = {
    at: 0
  };
  private configChangeHandler?: (cfg: any) => void;

  constructor(private adapter: ClawAdapter) {
    // 监听 config 变化，自动重排定时器
    this.configChangeHandler = () => this.restart();
    clawConfig.onChange(this.configChangeHandler);
  }

  /**
   * 启动定时器（由 ClawManager.start 调用）
   */
  start(): void {
    this.stop();
    this.scheduleNext();
    taskQueue.addLog('info', 'bridge', '[idle] 空闲提醒已启动');
  }

  /**
   * 停止（保留 lastSentAt，避免重启用后立刻重发）
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 重启（config 变更时自动调用）
   */
  restart(): void {
    this.start();
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.stop();
    this.lastSentAt.clear();
    if (this.configChangeHandler) {
      // 注：clawConfig.onChange 没有 off 接口，靠 GC 自然回收
      this.configChangeHandler = undefined;
    }
  }

  /**
   * 立即触发一次 tick（API 用：手动测试）
   */
  async tickNow(): Promise<{
    checked: number;
    sent: number;
    skipped: number;
    errors: string[];
    in_work_window: boolean;
  }> {
    return await this.tick();
  }

  // ============== 内部：定时调度 ==============

  private scheduleNext(): void {
    const cfg = clawConfig.get();
    if (!cfg.idle_enabled) {
      taskQueue.addLog('debug', 'bridge', '[idle] 已禁用，跳过调度');
      return;
    }
    const intervalMs = Math.max(1, cfg.idle_check_interval_min || 5) * 60 * 1000;
    this.timer = setTimeout(() => {
      this.tick()
        .catch(err => {
          this.lastSent.error = err.message;
          taskQueue.addLog('error', 'bridge', `[idle] tick 失败: ${err.message}`);
        })
        .finally(() => {
          // 不论成败，继续下一轮
          this.scheduleNext();
        });
    }, intervalMs);
  }

  // ============== 内部：tick 主逻辑 ==============

  private async tick(): Promise<{
    checked: number;
    sent: number;
    skipped: number;
    errors: string[];
    in_work_window: boolean;
  }> {
    const cfg = clawConfig.get();
    this.lastTickAt = Date.now();
    const errors: string[] = [];
    let sent = 0;
    let skipped = 0;

    // 1. 总开关
    if (!cfg.idle_enabled) {
      return { checked: 0, sent: 0, skipped: 0, errors: [], in_work_window: false };
    }

    // 2. 微信未连接
    if (this.adapter.getStatusSync().state !== 'connected') {
      taskQueue.addLog('debug', 'bridge', '[idle] 微信未连接，跳过');
      return { checked: 0, sent: 0, skipped: 0, errors: [], in_work_window: false };
    }

    // 3. 时间窗口
    const inWindow = this.isInWorkWindow(cfg.idle_work_hours!, cfg.idle_rest_hours!);
    if (!inWindow) {
      taskQueue.addLog('debug', 'bridge', '[idle] 当前不在工作时间窗口，跳过');
      return { checked: 0, sent: 0, skipped: 0, errors: [], in_work_window: false };
    }

    // 4. 活跃 wxid
    const actives = this.getActiveWxids();
    if (actives.length === 0) {
      taskQueue.addLog('debug', 'bridge', '[idle] 无活跃微信用户');
      return { checked: 0, sent: 0, skipped: 0, errors: [], in_work_window: true };
    }

    // 5. 逐个判断
    const now = Date.now();
    const minQuietMs = (cfg.idle_min_quiet_min ?? 5) * 60 * 1000;
    const cooldownMs = (cfg.idle_cooldown_min ?? 30) * 60 * 1000;
    const types = cfg.idle_message_types || ['daily_summary'];

    taskQueue.addLog('debug', 'bridge', `[idle] tick: actives=${actives.length}, minQuietMs=${minQuietMs}, cooldownMs=${cooldownMs}, types=${types.join(',')}`);

    for (const a of actives) {
      const lastActivity = Math.max(a.lastTaskAt || 0, a.lastMessageAt || 0);
      const quietFor = now - lastActivity;
      taskQueue.addLog('debug', 'bridge',
        `[idle] 检查 ${a.wxid.slice(0, 12)}… quietFor=${Math.round(quietFor/1000)}s lastTaskAt=${a.lastTaskAt} lastMessageAt=${a.lastMessageAt}`
      );
      if (quietFor < minQuietMs) {
        skipped++;
        taskQueue.addLog('debug', 'bridge', `[idle] 跳过 ${a.wxid.slice(0, 12)}… 静默时间不够 (${Math.round(quietFor/1000)}s < ${Math.round(minQuietMs/1000)}s)`);
        continue;
      }

      const lastSent = this.lastSentAt.get(a.wxid) || 0;
      if (now - lastSent < cooldownMs) {
        skipped++;
        taskQueue.addLog('debug', 'bridge', `[idle] 跳过 ${a.wxid.slice(0, 12)}… 冷却中 (${Math.round((now-lastSent)/1000)}s < ${Math.round(cooldownMs/1000)}s)`);
        continue;
      }

      // 构造消息
      const text = this.composeIdleText(types, a, quietFor);
      if (!text) {
        skipped++;
        taskQueue.addLog('debug', 'bridge', `[idle] 跳过 ${a.wxid.slice(0, 12)}… 消息文本为空`);
        continue;
      }

      // 发送（带重试）
      const ok = await this.sendWithRetry(a.wxid, text, 2);
      if (ok) {
        this.lastSentAt.set(a.wxid, now);
        this.lastSent = { wxid: a.wxid, at: now, status: 'success' };
        sent++;
        taskQueue.addLog('success', 'task',
          `微信空闲提醒: → ${a.wxid} (静默 ${Math.round(quietFor / 60000)} 分钟, msgLen=${text.length})`,
          { wechat_wxid: a.wxid, kind: 'idle_reminder', quiet_for_min: Math.round(quietFor / 60000), text_len: text.length }
        );
      } else {
        this.lastSent = { wxid: a.wxid, at: now, status: 'failed', error: 'send_failed' };
        errors.push(`${a.wxid}: send_failed`);
        // 失败不写入 lastSentAt，下次可重试
      }
    }

    return { checked: actives.length, sent, skipped, errors, in_work_window: true };
  }

  // ============== 内部：时间窗口判断 ==============

  private isInWorkWindow(work: TimeWindow, rest: TimeWindow): boolean {
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;

    // 休息时间优先：跨天（如 22-7）则 start > end
    if (rest.start > rest.end) {
      if (hour >= rest.start || hour < rest.end) return false;
    } else if (rest.start < rest.end) {
      if (hour >= rest.start && hour < rest.end) return false;
    }

    // 工作时间
    if (work.start >= work.end) return false;  // 非法配置
    if (hour < work.start || hour >= work.end) return false;
    return true;
  }

  // ============== 内部：活跃 wxid 收集 ==============

  private getActiveWxids(): ActiveWxid[] {
    const sessions = sessionManager.listSessions();
    const map = new Map<string, ActiveWxid>();

    for (const s of sessions) {
      const wxid = (s.meta as any)?.wechat_wxid;
      if (!wxid) continue;

      // 找该 session 最后一条 task 完成时间
      const recent = taskQueue.getRecentTasks(5, { session_id: s.id });
      const lastCompleted = recent
        .filter(t => t.completed_at)
        .map(t => t.completed_at!)
        .reduce((a, b) => Math.max(a, b), 0);

      // 入站消息时间（从 session meta 或 update_at 推断）
      const lastMessageAt = (s.meta as any)?.last_message_at || s.updated_at || s.created_at;

      const existing = map.get(wxid);
      const candidate: ActiveWxid = {
        wxid,
        sessionId: s.id,
        lastTaskAt: Math.max(existing?.lastTaskAt || 0, lastCompleted),
        lastMessageAt: Math.max(existing?.lastMessageAt || 0, lastMessageAt)
      };
      map.set(wxid, candidate);
    }

    return Array.from(map.values());
  }

  // ============== 内部：消息构造 ==============

  private composeIdleText(types: string[], a: ActiveWxid, quietForMs: number): string {
    const parts: string[] = [];
    const quietMin = Math.round(quietForMs / 60000);

    for (const t of types) {
      if (t === 'daily_summary') {
        const part = this.composeDailySummary();
        if (part) parts.push(part);
      } else if (t === 'task_summary') {
        const part = this.composeTaskSummary(a.sessionId);
        if (part) parts.push(part);
      }
    }

    if (parts.length === 0) return '';

    const header = `💡 空闲提醒（已 ${quietMin} 分钟无活动）\n${'─'.repeat(20)}\n\n`;
    return header + parts.join('\n\n');
  }

  /**
   * 今日数据摘要（从 storage 聚合，0 成本）
   */
  private composeDailySummary(): string {
    try {
      const allTasks = storage.getAllTasks();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStart = today.getTime();

      const todayTasks = allTasks.filter(t => (t.created_at || 0) >= todayStart);
      const completed = todayTasks.filter(t => t.status === 'completed').length;
      const failed = todayTasks.filter(t => t.status === 'failed').length;
      const inflight = todayTasks.filter(t => t.status === 'pending' || t.status === 'processing').length;

      const totalDone = completed + failed;
      const successRate = totalDone > 0 ? Math.round((completed / totalDone) * 100) : null;

      // 当前运行总数
      const allTotal = allTasks.length;
      const allDone = allTasks.filter(t => t.status === 'completed').length;
      const allRate = allTotal > 0 ? Math.round((allDone / allTotal) * 100) : 0;

      const lines = [
        '📊 今日数据摘要',
        `• 任务：${todayTasks.length} 条（完成 ${completed} / 失败 ${failed} / 进行中 ${inflight}）`,
        `• 今日成功率：${successRate == null ? '—' : successRate + '%'}`,
        `• 累计：${allTotal} 任务 / ${allRate}% 完成`
      ];
      return lines.join('\n');
    } catch (e) {
      taskQueue.addLog('warn', 'bridge', `[idle] composeDailySummary 失败: ${(e as Error).message}`);
      return '';
    }
  }

  /**
   * 任务总结：复用 message-bridge 的 composeSummary 逻辑（独立实现，避免循环依赖）
   */
  private composeTaskSummary(sessionId: string): string {
    try {
      const tasks = taskQueue.getRecentTasks(10, { session_id: sessionId })
        .filter(t => t.completed_at)
        .sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0))
        .slice(0, 10) as Task[];

      if (tasks.length === 0) return '';

      const lines: string[] = [`📋 最近任务总结（${tasks.length} 条）`];
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const q = (t.data?.content || '').slice(0, 22);
        const dots = t.data?.content && t.data.content.length > 22 ? '…' : '';
        const icon = t.result?.status === 'success' ? '✅' : (t.result?.status === 'failed' ? '❌' : '⏳');
        const a = (t.result?.result?.summary || '(无回复)').slice(0, 30);
        const aDots = (t.result?.result?.summary || '').length > 30 ? '…' : '';
        lines.push(`${i + 1}. ${icon} 「${q}${dots}」→ ${a}${aDots}`);
      }
      return lines.join('\n');
    } catch (e) {
      taskQueue.addLog('warn', 'bridge', `[idle] composeTaskSummary 失败: ${(e as Error).message}`);
      return '';
    }
  }

  // ============== 内部：发送 + 重试 ==============

  private async sendWithRetry(wxid: string, text: string, maxAttempts: number): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const msgId = await this.adapter.sendText(wxid, text);
        taskQueue.addLog('debug', 'task',
          `[idle] 发送成功: ${wxid} (msgId=${msgId}, attempt=${attempt})`,
          { wechat_wxid: wxid, kind: 'idle_reminder', msg_id: msgId, attempt }
        );
        return true;
      } catch (err: any) {
        taskQueue.addLog('warn', 'bridge',
          `[idle] 发送失败: ${wxid} (attempt=${attempt}/${maxAttempts}): ${err.message}`,
          { wechat_wxid: wxid, kind: 'idle_reminder', attempt, error: err.message }
        );
        if (attempt < maxAttempts) {
          // 指数退避 1s, 2s
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
      }
    }
    return false;
  }

  // ============== API：状态查询 ==============

  getStatus(): IdleStatus {
    const cfg = clawConfig.get();
    const cooldowns: IdleStatus['cooldowns'] = [];
    const now = Date.now();
    const cooldownMs = (cfg.idle_cooldown_min ?? 30) * 60 * 1000;
    for (const [wxid, ts] of this.lastSentAt.entries()) {
      cooldowns.push({
        wxid,
        last_sent_at: ts,
        next_avail_at: ts + cooldownMs
      });
    }
    return {
      enabled: !!cfg.idle_enabled,
      check_interval_min: cfg.idle_check_interval_min ?? 5,
      min_quiet_min: cfg.idle_min_quiet_min ?? 5,
      work_hours: cfg.idle_work_hours || { start: 9, end: 18 },
      rest_hours: cfg.idle_rest_hours || { start: 22, end: 7 },
      message_types: cfg.idle_message_types || ['daily_summary'],
      cooldown_min: cfg.idle_cooldown_min ?? 30,
      in_work_window: this.isInWorkWindow(
        cfg.idle_work_hours || { start: 9, end: 18 },
        cfg.idle_rest_hours || { start: 22, end: 7 }
      ),
      active_wxid_count: this.getActiveWxids().length,
      last_tick_at: this.lastTickAt,
      last_sent_at: this.lastSent.at,
      last_sent_wxid: this.lastSent.wxid,
      last_sent_status: this.lastSent.status,
      last_error: this.lastSent.error,
      cooldowns
    };
  }
}

export const idleNotifier: IdleNotifier | null = null;  // 占位，实际由 ClawManager 实例化
