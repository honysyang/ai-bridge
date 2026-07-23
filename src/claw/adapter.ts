// ======== 微信 Claw 适配器抽象类 ========
//
// v4.1.0: 只实现 iLink Bot API（基于 @tencent-weixin/openclaw-weixin）。

import { EventEmitter } from 'events';
import {
  ClawStatus,
  WeChatMessage,
  WeChatContact,
  ClawEvents,
} from './types.js';

export abstract class ClawAdapter extends EventEmitter {
  protected status: ClawStatus = {
    state: 'disconnected',
    adapter_name: 'ilink',
  };

  // 生命周期
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  // 状态查询
  getStatusSync(): ClawStatus {
    return { ...this.status };
  }
  abstract getStatus(): Promise<ClawStatus>;

  // 消息发送
  abstract sendText(wxid: string, content: string): Promise<string>;

  // 联系人（iLink 个人 Bot 不支持，返回空数组）
  abstract listContacts(): Promise<WeChatContact[]>;
  abstract listRooms(): Promise<WeChatContact[]>;

  // 兜底轮询（iLink 用长轮询主动推送，返回空）
  abstract pollNewMessages(since?: number): Promise<WeChatMessage[]>;

  // 主动操作
  abstract logout(): Promise<void>;

  /**
   * 获取当前二维码原始内容（深链 + 过期时间），供后端用 qrcode 库渲染 PNG。
   * 未在扫码态时返回 undefined。
   */
  getCurrentQrcode(): { url: string; expiresAt: number } | undefined {
    return undefined;
  }

  // 内部状态变更（子类调用）
  protected setStatus(patch: Partial<ClawStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatusSync());
  }

  // 类型化事件
  on<K extends keyof ClawEvents>(event: K, listener: ClawEvents[K]): this {
    return super.on(event, listener as any);
  }

  off<K extends keyof ClawEvents>(event: K, listener: ClawEvents[K]): this {
    return super.off(event, listener as any);
  }

  emit<K extends keyof ClawEvents>(
    event: K,
    ...args: Parameters<ClawEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
