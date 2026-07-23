// ======== 微信消息桥接（v4.0.0） ========
//
// 职责：
// 1. 接收 adapter.on('message') → 去重 → 查/建 session → taskQueue.addTask
// 2. 监听 taskQueue.on('task_completed') → 若 source=wechat 则 adapter.sendText

import { ClawAdapter } from './adapter.js';
import { MessageDedup } from './dedup.js';
import { clawConfig } from './config.js';
import { WeChatMessage } from './types.js';
import { taskQueue } from '../task-queue.js';
import { sessionManager } from '../session.js';
import { TaskResult } from '../types.js';

export class MessageBridge {
  private dedup: MessageDedup;
  private taskCompletedHandler?: (result: TaskResult) => void;

  constructor(private adapter: ClawAdapter) {
    this.dedup = new MessageDedup();

    // 微信消息 → 任务
    this.adapter.on('message', (msg) => this.handleIncoming(msg));

    // 任务完成 → 回微信
    this.taskCompletedHandler = (result) => this.handleOutgoing(result);
    taskQueue.on('task_completed', this.taskCompletedHandler);

    // adapter 错误日志
    this.adapter.on('error', (err) => {
      taskQueue.addLog('error', 'bridge', `[claw] ${err.message}`);
    });
  }

  /**
   * 处理入站微信消息
   */
  private handleIncoming(msg: WeChatMessage): void {
    // 1. 去重
    const cfg = clawConfig.get();
    if (this.dedup.has(msg.msg_id, cfg.message_dedup_ttl_ms)) {
      taskQueue.addLog('debug', 'bridge', `微信消息重复，跳过: ${msg.msg_id}`);
      return;
    }

    // 2. 查/建 session（按 wxid）
    const session = this.getOrCreateWechatSession(msg);

    // 3. 创建任务
    const task = taskQueue.addTask({
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
        wechat_timestamp: msg.timestamp
      }
    } as any);

    // 4. 刷新会话时间
    sessionManager.touchSession(session.id);

    taskQueue.addLog('info', 'task',
      `微信消息入队: ${msg.from_user} → ${task.id} (session=${session.id})`,
      { task_id: task.id, session_id: session.id, wechat_msg_id: msg.msg_id }
    );
  }

  /**
   * 处理出站（任务完成 → 微信回复）
   */
  private handleOutgoing(result: TaskResult): void {
    const cfg = clawConfig.get();
    if (!cfg.auto_reply) return;

    const task = taskQueue.getTask(result.task_id);
    if (!task || task.source !== 'wechat') return;

    const wxid = (task.context as any)?.wechat_wxid;
    if (!wxid) return;

    const summary = result.result?.summary || '';
    if (!summary) {
      taskQueue.addLog('warn', 'bridge', `任务 ${result.task_id} 无 summary，跳过微信回复`);
      return;
    }

    // 异步发送，不阻塞 event loop
    this.adapter.sendText(wxid, summary)
      .then((msgId) => {
        taskQueue.addLog('success', 'task',
          `微信回复成功: ${task.id} → ${wxid} (msgId=${msgId})`,
          { task_id: task.id, wechat_wxid: wxid, reply_msg_id: msgId }
        );
      })
      .catch((err) => {
        taskQueue.addLog('error', 'bridge',
          `微信回复失败: ${task.id} → ${wxid}: ${err.message}`,
          { task_id: task.id, wechat_wxid: wxid }
        );
      });
  }

  /**
   * 查/建微信会话
   */
  private getOrCreateWechatSession(msg: WeChatMessage): any {
    const allSessions = sessionManager.listSessions();
    const found = allSessions.find(
      s => (s.meta as any)?.wechat_wxid === msg.wxid
    );
    if (found) return found;

    const name = msg.room_wxid
      ? `微信群 · ${msg.from_user}`
      : `微信 · ${msg.from_user}`;

    return sessionManager.createSession({
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
   * 清理
   */
  destroy(): void {
    if (this.taskCompletedHandler) {
      taskQueue.off('task_completed', this.taskCompletedHandler);
      this.taskCompletedHandler = undefined;
    }
    this.dedup.clear();
  }
}
