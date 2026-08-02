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
    this.lastQrcode = null; // 缓存最近一次 'qrcode' 事件内容 { qrcode, url, expiresAt, img }
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
    // 缓存 qrcode 事件内容，供 routes/claw.js 的 GET /status、/qrcode.png 读取
    this.adapter.on('qrcode', (info) => {
      this.lastQrcode = {
        qrcode: info?.qrcode || null,
        url: info?.url || null,
        img: info?.img || null,
        expiresAt: info?.expiresAt || (Date.now() + 180_000),
        at: Date.now(),
      };
      appendLog('info', 'qrcode', '已缓存 qrcode 事件，等待扫码');
    });
    appendLog('info', 'lifecycle', '启动 iLink adapter');
    try { await this.adapter.start(); }
    catch (e) { appendLog('error', 'lifecycle', `启动失败: ${e.message}`); }
  }

  async stop() {
    if (!this.adapter) return;
    try { await this.adapter.stop(); } catch { /* ignore */ }
    this.adapter = null;
    this.lastQrcode = null;
  }

  getStatus() {
    if (process.env.ILINK_MOCK === '1') {
      return { state: 'mock', adapter: 'mock', account: 'mock_user', mock: true };
    }
    if (!this.adapter) {
      return { state: 'disconnected', adapter: 'ilink', account: null, mock: false, needsQrcode: !hasIlinkCredentials() };
    }
    const s = this.adapter.getStatusSync();
    // 把最近一次二维码事件附加到状态里，便于前端 /api/claw/status 一次拉到
    if (this.lastQrcode && s.state === 'qrcode') {
      s.qrcode = this.lastQrcode.qrcode;
      s.qrcodeUrl = this.lastQrcode.url || this.lastQrcode.img;
      s.qrcodeExpiresAt = this.lastQrcode.expiresAt;
    }
    return s;
  }

  /** 取最近一次缓存的二维码（供 /qrcode.png 直接绘制） */
  getQrcode() {
    return this.lastQrcode ? { ...this.lastQrcode } : null;
  }

  /** 清除缓存的二维码（用于 connected 后避免残留） */
  clearQrcode() { this.lastQrcode = null; }

  getAdapter() { return this.adapter; }

  /** 触发扫码：先 logout，再 startQrcodeFlow */
  async startQrcode(ctx) {
    if (!this.adapter) await this.startIlink(ctx);
    if (!this.adapter) throw new Error('adapter not initialized');
    await this.adapter.logout();
    this.lastQrcode = null;
    await this.adapter.startQrcodeFlow();
    return this.adapter.getStatusSync();
  }

  async sendText(wxid, text) {
    if (!this.adapter) throw new Error('not_connected');
    return this.adapter.sendText(wxid, text);
  }
}

export const clawManager = new ClawManager();
