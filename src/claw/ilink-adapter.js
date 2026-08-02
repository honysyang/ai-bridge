// ilink-adapter.js —— iLink Bot 适配器（v7 简化移植自 v6）
// 状态机：disconnected → qrcode → connected → reconnecting
// 行为：
//   1. 启动时从 secrets.env 读凭证，有则直连；无则触发扫码
//   2. 长轮询（35s）拿新消息，emit 'message' 事件
//   3. ret=-14（凭证过期）→ 重新走扫码
//   4. emit 'status' 状态变更，emit 'qrcode' 当前二维码
import { EventEmitter } from 'node:events';
import {
  getBotQrcode, getQrcodeStatus, getUpdates, sendMessage,
  buildTextMessage, resolveBaseUrl,
} from './ilink/api.js';
import { getSecrets, appendLog } from './ilink/shim.js';
import { writeSecrets, clearSecrets } from './secrets.js';
import { MessageDedup } from './dedup.js';

const LONG_POLL_MS = 35_000;
const QR_POLL_MS = 2_000;

export class IlinkAdapter extends EventEmitter {
  constructor() {
    super();
    this.status = {
      state: 'disconnected', // disconnected | qrcode | connected | reconnecting
      adapter: 'ilink',
      account: null,
      qrcode: null,
      qrcodeUrl: null,
      qrcodeExpiresAt: null,
      connectedAt: null,
      error: null,
    };
    this.pollAbort = null;
    this.qrPollAbort = null;
    this.dedup = new MessageDedup();
    this.getUpdatesBuf = '';
  }

  getStatusSync() { return { ...this.status }; }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatusSync());
  }

  async start() {
    const secrets = getSecrets();
    const baseUrl = secrets.ILINK_BASE_URL || resolveBaseUrl();
    const token = secrets.ILINK_BOT_TOKEN;
    if (token && secrets.ILINK_BOT_ID && secrets.ILINK_USER_ID) {
      appendLog('info', 'lifecycle', '已有凭证，尝试直连');
      this.getUpdatesBuf = secrets.ILINK_GET_UPDATES_BUF || '';
      this.setStatus({ state: 'reconnecting', error: null });
      try {
        // notifyStart 通知 bot 启动
        await this._loop(); // 直接进入长轮询（notifyStart 内部按需）
      } catch (e) {
        appendLog('error', 'lifecycle', `直连失败: ${e.message}`);
        this.setStatus({ state: 'disconnected', error: e.message });
        // 失败时清除凭证，走扫码
        clearSecrets('ILINK_BOT_TOKEN', 'ILINK_BOT_ID', 'ILINK_USER_ID', 'ILINK_GET_UPDATES_BUF');
        await this.startQrcodeFlow();
      }
    } else {
      await this.startQrcodeFlow();
    }
  }

  async stop() {
    this.pollAbort?.abort();
    this.qrPollAbort?.abort();
    this.pollAbort = null;
    this.qrPollAbort = null;
    this.setStatus({ state: 'disconnected' });
  }

  /* ==================== 扫码流程 ==================== */
  async startQrcodeFlow() {
    this.qrPollAbort?.abort();
    this.qrPollAbort = new AbortController();
    this.setStatus({ state: 'qrcode', qrcode: null, qrcodeUrl: null, error: null });
    const baseUrl = resolveBaseUrl();
    try {
      const r = await getBotQrcode(baseUrl, 3, 10000);
      this.setStatus({
        qrcode: r.qrcode,
        qrcodeUrl: r.qrcode_img_content || r.qrcode,
        qrcodeExpiresAt: r.expires_at || (Date.now() + 180_000),
      });
      appendLog('info', 'qrcode', `已获取二维码 qrcode=${r.qrcode?.slice(0, 8)}…`);
      this.emit('qrcode', { qrcode: r.qrcode, url: r.qrcode_img_content || r.qrcode, expiresAt: r.expires_at });
      this._pollQrcodeStatus(baseUrl, r.qrcode);
    } catch (e) {
      this.setStatus({ state: 'disconnected', error: e.message });
      appendLog('error', 'qrcode', `获取二维码失败: ${e.message}`);
      this.emit('error', e);
    }
  }

  async _pollQrcodeStatus(baseUrl, qrcode) {
    const ac = this.qrPollAbort;
    const tick = async () => {
      while (!ac.signal.aborted) {
        try {
          const r = await getQrcodeStatus(baseUrl, qrcode, 8000);
          if (r.status === 'confirmed' || r.status === 'scaned') {
            // 优先 confirmed（已确认登录），scaned 表示扫了但没确认
            if (r.status === 'confirmed' && r.bot_token) {
              // 保存凭证
              writeSecrets({
                ILINK_BOT_TOKEN: r.bot_token,
                ILINK_BOT_ID: r.ilink_bot_id || '',
                ILINK_USER_ID: r.ilink_user_id || '',
                ILINK_BASE_URL: r.baseurl || baseUrl,
              });
              appendLog('info', 'qrcode', '扫码确认，已写入凭证');
              ac.abort();
              this.setStatus({ state: 'connected', account: r.ilink_user_id, connectedAt: Date.now(), error: null });
              this._loop();
              return;
            }
          } else if (r.status === 'expired') {
            appendLog('warn', 'qrcode', '二维码过期，重新生成');
            ac.abort();
            this.startQrcodeFlow();
            return;
          }
        } catch (e) {
          appendLog('error', 'qrcode', `轮询失败: ${e.message}`);
        }
        await new Promise((res) => setTimeout(res, QR_POLL_MS));
      }
    };
    tick();
  }

  /* ==================== 长轮询拿消息 ==================== */
  async _loop() {
    this.pollAbort?.abort();
    this.pollAbort = new AbortController();
    const ac = this.pollAbort;
    const secrets = getSecrets();
    const baseUrl = secrets.ILINK_BASE_URL || resolveBaseUrl();
    const token = secrets.ILINK_BOT_TOKEN;
    const userId = secrets.ILINK_USER_ID || '';

    while (!ac.signal.aborted) {
      try {
        const r = await getUpdates(baseUrl, token, this.getUpdatesBuf, LONG_POLL_MS);
        if (r.ret === -14) {
          // 凭证过期
          appendLog('warn', 'lifecycle', '凭证过期（ret=-14），重新扫码');
          clearSecrets('ILINK_BOT_TOKEN', 'ILINK_BOT_ID', 'ILINK_USER_ID', 'ILINK_GET_UPDATES_BUF');
          ac.abort();
          await this.startQrcodeFlow();
          return;
        }
        if (r.get_updates_buf) this.getUpdatesBuf = r.get_updates_buf;
        // 持久化 buf
        if (this.getUpdatesBuf) writeSecrets({ ILINK_GET_UPDATES_BUF: this.getUpdatesBuf });
        if (Array.isArray(r.msgs) && r.msgs.length) {
          for (const m of r.msgs) {
            const msgId = String(m.message_id || m.client_id || '');
            if (!msgId || this.dedup.has(msgId)) continue;
            this._normalizeAndEmit(m, userId);
          }
        }
      } catch (e) {
        appendLog('error', 'lifecycle', `长轮询异常: ${e.message}`);
        await new Promise((res) => setTimeout(res, 3_000));
      }
    }
  }

  /** 把 iLink 内部消息转成统一 WeChatMessage 并 emit */
  _normalizeAndEmit(m, botUserId) {
    // 文本提取
    const textItem = m.item_list?.find((i) => i.type === 1);
    const text = textItem?.text_item?.text || '';
    // 群消息：from_user_id 是发送者，to_user_id 是群；私聊：to_user_id 是 bot
    const isRoom = !!m.group_id || (m.to_user_id !== botUserId && m.from_user_id !== botUserId && m.session_id?.includes('@chatroom'));
    const weixinMsg = {
      msgId: String(m.message_id || m.client_id || ''),
      fromUser: m.from_user_id || '',
      toUser: m.to_user_id || '',
      groupId: m.group_id || null,
      sessionId: m.session_id || null,
      isRoom,
      text,
      messageType: m.message_type || 1,
      createTimeMs: m.create_time_ms || Date.now(),
      contextToken: m.context_token || null,
      raw: m,
    };
    appendLog('info', 'incoming', `收消息 from=${weixinMsg.fromUser} ${isRoom ? '[群]' : '[私]'} text=${text.slice(0, 50)}`);
    this.emit('message', weixinMsg);
  }

  /* ==================== 发消息 ==================== */
  async sendText(targetUserId, text) {
    const secrets = getSecrets();
    const baseUrl = secrets.ILINK_BASE_URL || resolveBaseUrl();
    const token = secrets.ILINK_BOT_TOKEN;
    const botUserId = secrets.ILINK_USER_ID || '';
    if (!token) throw new Error('not_connected');
    const msg = buildTextMessage({ toUserId: targetUserId, text, fromUserId: botUserId });
    const r = await sendMessage(baseUrl, token, msg);
    appendLog('info', 'outgoing', `发消息 to=${targetUserId} ret=${r.ret}`);
    return r;
  }

  async logout() {
    this.pollAbort?.abort();
    this.qrPollAbort?.abort();
    clearSecrets('ILINK_BOT_TOKEN', 'ILINK_BOT_ID', 'ILINK_USER_ID', 'ILINK_GET_UPDATES_BUF');
    this.setStatus({ state: 'disconnected', account: null, qrcode: null, qrcodeUrl: null });
  }
}
