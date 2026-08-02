// index.js —— 微信 Claw 模块入口（v7）
// 启动策略：
//   1. 启动时检查 secrets.env 是否有 iLink 凭证
//   2. 有 → 启动 IlinkAdapter（直连）
//   3. 无 → 不启动 adapter，前端显示"未连接"+ 触发扫码入口
//   4. mock 模式：当 ILINK_MOCK=1 时，adapter 用 mock（不连 iLink，模拟收消息）
import { IlinkAdapter } from './ilink-adapter.js';
import { hasIlinkCredentials } from './secrets.js';
import { appendLog } from './ilink/shim.js';

class ClawManager {
  constructor() {
    this.adapter = null;
    this.onMessage = null; // (msg) => void，由 routes/claw.js 注入
  }

  /**
   * 启动（由 server.js / index.js 调用）
   * @param {object} ctx { store, events, util }
   */
  async start(ctx) {
    if (process.env.ILINK_MOCK === '1') {
      appendLog('info', 'lifecycle', 'ILINK_MOCK=1，跳过真实 iLink 启动');
      return;
    }
    if (!hasIlinkCredentials()) {
      appendLog('info', 'lifecycle', '无 iLink 凭证，等待用户扫码');
      return;
    }
    await this.startIlink(ctx);
  }

  async startIlink(ctx) {
    await this.stop();
    this.adapter = new IlinkAdapter();
    this.adapter.on('message', (msg) => {
      if (typeof this.onMessage === 'function') {
        try { this.onMessage(msg, ctx); } catch (e) {
          appendLog('error', 'manager', `消息处理失败: ${e.message}`);
        }
      }
    });
    this.adapter.on('status', (s) => {
      if (ctx?.store?.log) ctx.store.log('info', 'claw', `状态变更: ${s.state} ${s.account || ''}`);
    });
    appendLog('info', 'lifecycle', '启动 iLink adapter');
    try { await this.adapter.start(); }
    catch (e) { appendLog('error', 'lifecycle', `启动失败: ${e.message}`); }
  }

  async stop() {
    if (!this.adapter) return;
    try { await this.adapter.stop(); } catch { /* ignore */ }
    this.adapter = null;
  }

  getStatus() {
    if (process.env.ILINK_MOCK === '1') {
      return { state: 'mock', adapter: 'mock', account: 'mock_user', mock: true };
    }
    if (!this.adapter) {
      return { state: 'disconnected', adapter: 'ilink', account: null, mock: false, needsQrcode: !hasIlinkCredentials() };
    }
    return this.adapter.getStatusSync();
  }

  getAdapter() { return this.adapter; }

  /** 触发扫码：先 logout，再 start */
  async startQrcode(ctx) {
    if (!this.adapter) await this.startIlink(ctx);
    if (!this.adapter) throw new Error('adapter not initialized');
    await this.adapter.logout();
    await this.adapter.startQrcodeFlow();
    return this.adapter.getStatusSync();
  }

  async sendText(wxid, text) {
    if (!this.adapter) throw new Error('not_connected');
    return this.adapter.sendText(wxid, text);
  }
}

export const clawManager = new ClawManager();
