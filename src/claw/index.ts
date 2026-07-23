// ======== Claw 模块入口 (v4.1.0) ========
//
// v4.1.0: 只支持 iLink Bot API。
// 凭证统一存 ~/.config/agent-canvas/secrets.env。

import { ClawAdapter } from './adapter.js';
import { IlinkAdapter } from './ilink-adapter.js';
import { MessageBridge } from './message-bridge.js';
import { clawConfig } from './config.js';
import { ClawStatus, WeChatMessage } from './types.js';
import { taskQueue } from '../task-queue.js';

class ClawManager {
  private adapter: ClawAdapter | null = null;
  private bridge: MessageBridge | null = null;

  /**
   * 启动 claw（由 server.ts.startServer 调用）
   */
  async start(): Promise<void> {
    const cfg = clawConfig.get();
    if (!cfg.enabled) {
      taskQueue.addLog('info', 'bridge', '[claw] 已禁用，跳过启动（设置 data/claw-config.json: enabled=true 启用）');
      return;
    }
    await this.startIlink();
  }

  /**
   * 启动 iLink adapter
   */
  async startIlink(): Promise<void> {
    await this.stop();
    this.adapter = new IlinkAdapter();
    this.bridge = new MessageBridge(this.adapter);
    taskQueue.addLog('info', 'bridge', '[claw] 启动 iLink adapter');
    try {
      await this.adapter.start();
    } catch (e: any) {
      taskQueue.addLog('error', 'bridge', `[claw] 启动失败: ${e.message}`);
    }
  }

  /**
   * 停止
   */
  async stop(): Promise<void> {
    if (!this.adapter) return;
    try {
      await this.adapter.stop();
    } catch {}
    this.bridge?.destroy();
    this.bridge = null;
    this.adapter = null;
  }

  /**
   * 重启 adapter（保留长连接配置）
   */
  async restart(): Promise<void> {
    await this.startIlink();
  }

  /**
   * 获取当前状态
   */
  getStatus(): ClawStatus {
    if (!this.adapter) {
      return { state: 'disconnected', adapter_name: 'ilink' };
    }
    return this.adapter.getStatusSync();
  }

  /**
   * 获取 adapter
   */
  getAdapter(): ClawAdapter | null {
    return this.adapter;
  }

  /**
   * 向后兼容（始终返回 false）
   */
  isMock(): boolean {
    return false;
  }
}

export const clawManager = new ClawManager();

// 避免未使用的导入警告
export type { WeChatMessage };
