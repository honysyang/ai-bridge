/**
 * iLink Bot Adapter（v4.1.0）
 *
 * 职责：
 * 1. 实现 ClawAdapter 抽象接口
 * 2. 调用 vendor SDK（./ilink/api.ts）的 7 个端点
 * 3. 凭证管理：从 ~/.config/agent-canvas/secrets.env 读取
 * 4. 状态机：disconnected → qrcode → connected → reconnecting
 * 5. 长轮询（35s）持续拉取新消息，emit 'message' 事件
 * 6. 自动处理 ret=-14（凭证过期）→ 重新走扫码流程
 *
 * 凭证存 secrets.env：
 *   ILINK_BASE_URL=https://ilinkai.weixin.qq.com
 *   ILINK_BOT_TOKEN=xxx
 *   ILINK_BOT_ID=xxx
 *   ILINK_USER_ID=xxx
 *   ILINK_GET_UPDATES_BUF=<base64 cursor>  # 可选，保留上下文
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClawAdapter } from './adapter.js';
import { ClawStatus, WeChatMessage } from './types.js';
import {
  getBotQrcode,
  getQrcodeStatus,
  getUpdates,
  sendMessage as sdkSendMessage,
  getConfig as sdkGetConfig,
  sendTyping as sdkSendTyping,
  notifyStart,
  notifyStop,
} from './ilink/api.js';
import { reloadSecrets } from './ilink/shim.js';
import { MessageItemType, MessageType, MessageState } from './ilink/types.js';

const SECRETS_FILE = path.join(os.homedir(), '.config', 'agent-canvas', 'secrets.env');
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QRCODE_POLL_INTERVAL_MS = 2000;
const QRCODE_REFRESH_MAX = 3;

interface ILinkCredentials {
  bot_token: string;
  baseurl: string;
  ilink_bot_id: string;
  ilink_user_id: string;
  nickname?: string;
}

function readSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!fs.existsSync(SECRETS_FILE)) return out;
    const content = fs.readFileSync(SECRETS_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      out[k] = v;
    }
  } catch {
    // best-effort
  }
  return out;
}

function writeSecrets(updates: Record<string, string>): void {
  try {
    const dir = path.dirname(SECRETS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = readSecrets();
    const merged = { ...existing, ...updates };
    const lines: string[] = [
      '# Agent Canvas - 本地密钥管理（自动维护，请勿手改）',
      '# Permissions: 600 (chmod)',
      '',
    ];
    for (const [k, v] of Object.entries(merged)) {
      if (v === '' || v == null) continue;
      // 对含特殊字符的值加引号
      if (/[\s"'#=]/.test(v)) {
        lines.push(`${k}="${v.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${k}=${v}`);
      }
    }
    fs.writeFileSync(SECRETS_FILE, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
    // chmod 600（双保险）
    try {
      fs.chmodSync(SECRETS_FILE, 0o600);
    } catch {}
    reloadSecrets();
  } catch (e) {
    // best-effort
    console.error('[ilink] 写入 secrets.env 失败:', e);
  }
}

function clearSecrets(...keys: string[]): void {
  try {
    const existing = readSecrets();
    for (const k of keys) delete existing[k];
    const lines: string[] = ['# Agent Canvas - 本地密钥管理'];
    for (const [k, v] of Object.entries(existing)) {
      if (!v) continue;
      lines.push(/[\s"'#=]/.test(v) ? `${k}="${v.replace(/"/g, '\\"')}"` : `${k}=${v}`);
    }
    fs.writeFileSync(SECRETS_FILE, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(SECRETS_FILE, 0o600);
    } catch {}
    reloadSecrets();
  } catch {}
}

export class IlinkAdapter extends ClawAdapter {
  private pollAbort?: AbortController;
  private qrcodePollAbort?: AbortController;
  private currentQrcode?: { qrcode: string; imgUrl: string; expiresAt: number; refreshCount: number };
  private getUpdatesBuf: string = '';
  // 每个 from_user_id 对应一个 context_token（用于回复）
  private contextTokens: Map<string, string> = new Map();
  // typing_ticket 按 user 缓存（24h 有效）
  private typingTickets: Map<string, { ticket: string; fetchedAt: number }> = new Map();

  constructor() {
    super();
    this.setStatus({ state: 'disconnected', adapter_name: 'ilink' });
  }

  /**
   * 启动：先尝试读 secrets.env 中的凭证，如有则直接连；无则走扫码。
   */
  async start(): Promise<void> {
    const secrets = readSecrets();
    const baseUrl = secrets.ILINK_BASE_URL || DEFAULT_BASE_URL;
    const token = secrets.ILINK_BOT_TOKEN;

    if (token && secrets.ILINK_BOT_ID && secrets.ILINK_USER_ID) {
      // 已有凭证，跳过扫码
      this.getUpdatesBuf = secrets.ILINK_GET_UPDATES_BUF || '';
      this.setStatus({
        state: 'connecting',
        adapter_name: 'ilink',
        wxid: secrets.ILINK_BOT_ID,
        nickname: secrets.ILINK_NICKNAME || 'iLink Bot',
      });
      try {
        await notifyStart({ baseUrl, token });
        this.setStatus({
          state: 'connected',
          wxid: secrets.ILINK_BOT_ID,
          connected_at: Date.now(),
          last_heartbeat_at: Date.now(),
        });
        this.startLongPolling(baseUrl, token);
      } catch (e: any) {
        this.setStatus({ state: 'error', error_message: `notifyStart 失败: ${e.message}` });
        this.emit('error', e as Error);
        // 凭证可能已失效，回退到扫码
        clearSecrets('ILINK_BOT_TOKEN', 'ILINK_BOT_ID', 'ILINK_USER_ID', 'ILINK_NICKNAME', 'ILINK_GET_UPDATES_BUF');
        this.getUpdatesBuf = '';
        this.contextTokens.clear();
        this.typingTickets.clear();
        await this.startQrcodeFlow(baseUrl);
      }
    } else {
      // 无凭证，扫码
      await this.startQrcodeFlow(baseUrl);
    }
  }

  async stop(): Promise<void> {
    this.pollAbort?.abort();
    this.qrcodePollAbort?.abort();
    this.pollAbort = undefined;
    this.qrcodePollAbort = undefined;
    const secrets = readSecrets();
    if (secrets.ILINK_BOT_TOKEN && this.status.state === 'connected') {
      try {
        await notifyStop({ baseUrl: secrets.ILINK_BASE_URL || DEFAULT_BASE_URL, token: secrets.ILINK_BOT_TOKEN });
      } catch {
        // best-effort
      }
    }
    this.setStatus({ state: 'disconnected', adapter_name: 'ilink' });
  }

  async getStatus(): Promise<ClawStatus> {
    return this.getStatusSync();
  }

  /**
   * 返回当前二维码原始内容（深链 + 过期时间），用于后端用 qrcode 库渲染 PNG。
   * iLink 返回的 qrcode_img_content 是微信深链（https://liteapp.weixin.qq.com/q/...），
   * 浏览器不能直接当图片渲染，必须服务端转码。
   */
  getCurrentQrcode(): { url: string; expiresAt: number } | undefined {
    if (this.status.state !== 'qrcode' || !this.currentQrcode) return undefined;
    return {
      url: this.currentQrcode.imgUrl,
      expiresAt: this.currentQrcode.expiresAt,
    };
  }

  // ============= 扫码登录流程 =============

  private async startQrcodeFlow(baseUrl: string): Promise<void> {
    this.qrcodePollAbort?.abort();
    this.qrcodePollAbort = new AbortController();
    this.setStatus({ state: 'disconnected', adapter_name: 'ilink' });

    try {
      const { qrcode, qrcode_img_content } = await getBotQrcode({ baseUrl, botType: 3 });
      const expiresAt = Date.now() + 60_000;
      this.currentQrcode = { qrcode, imgUrl: qrcode_img_content, expiresAt, refreshCount: 0 };
      this.setStatus({
        state: 'qrcode',
        adapter_name: 'ilink',
        qrcode_url: qrcode_img_content,
        qrcode_expires_at: expiresAt,
      });
      this.emit('qrcode', { qrcode_url: qrcode_img_content, expires_at: expiresAt });
      this.pollQrcodeStatus(baseUrl, qrcode, 0);
    } catch (e: any) {
      this.setStatus({ state: 'error', error_message: `获取二维码失败: ${e.message}` });
      this.emit('error', e as Error);
    }
  }

  private pollQrcodeStatus(baseUrl: string, qrcode: string, refreshCount: number): void {
    const tick = async () => {
      while (this.qrcodePollAbort && !this.qrcodePollAbort.signal.aborted) {
        await new Promise((r) => setTimeout(r, QRCODE_POLL_INTERVAL_MS));
        if (this.qrcodePollAbort?.signal.aborted) return;
        try {
          const status = await getQrcodeStatus({ baseUrl, qrcode });
          if (status.status === 'confirmed' && status.bot_token) {
            const creds: ILinkCredentials = {
              bot_token: status.bot_token,
              baseurl: status.baseurl || baseUrl,
              ilink_bot_id: status.ilink_bot_id || '',
              ilink_user_id: status.ilink_user_id || '',
              nickname: 'iLink Bot',
            };
            // 写凭证到 secrets.env
            writeSecrets({
              ILINK_BASE_URL: creds.baseurl,
              ILINK_BOT_TOKEN: creds.bot_token,
              ILINK_BOT_ID: creds.ilink_bot_id,
              ILINK_USER_ID: creds.ilink_user_id,
              ILINK_NICKNAME: creds.nickname || 'iLink Bot',
            });
            this.qrcodePollAbort = undefined;
            this.currentQrcode = undefined;
            this.setStatus({
              state: 'connected',
              wxid: creds.ilink_bot_id,
              nickname: creds.nickname,
              connected_at: Date.now(),
              last_heartbeat_at: Date.now(),
            });
            try {
              await notifyStart({ baseUrl: creds.baseurl, token: creds.bot_token });
            } catch {}
            this.startLongPolling(creds.baseurl, creds.bot_token);
            return;
          }
          if (status.status === 'expired') {
            if (refreshCount >= QRCODE_REFRESH_MAX) {
              this.setStatus({ state: 'error', error_message: '二维码已过期，请重新点击登录' });
              this.emit('error', new Error('二维码已过期'));
              return;
            }
            this.currentQrcode = undefined;
            await this.startQrcodeFlow(baseUrl);
            return;
          }
          // 'wait' / 'scaned' 继续轮询
        } catch (e: any) {
          // 轮询失败不致命，继续
          this.emit('error', e as Error);
        }
      }
    };
    tick();
  }

  // ============= 长轮询 =============

  private startLongPolling(baseUrl: string, token: string): void {
    this.pollAbort?.abort();
    this.pollAbort = new AbortController();
    const signal = this.pollAbort.signal;

    const loop = async () => {
      while (!signal.aborted) {
        try {
          const resp = await getUpdates({
            baseUrl,
            token,
            get_updates_buf: this.getUpdatesBuf,
            abortSignal: signal,
            timeoutMs: 38_000, // 略大于 35s
          });
          this.getUpdatesBuf = resp.get_updates_buf || this.getUpdatesBuf;
          // 持久化游标
          if (this.getUpdatesBuf) {
            writeSecrets({ ILINK_GET_UPDATES_BUF: this.getUpdatesBuf });
          }
          // 处理消息
          for (const msg of resp.msgs || []) {
            this.handleMessage(msg);
          }
          this.setStatus({ last_heartbeat_at: Date.now() });
          // 错误码 -14 = 凭证过期
          if (resp.errcode === -14 || resp.ret === -14) {
            this.handleCredentialsExpired();
            return;
          }
        } catch (e: any) {
          if (signal.aborted) return;
          if (e.name === 'AbortError') {
            // 长轮询超时是正常的，回到循环
            continue;
          }
          this.emit('error', e as Error);
          // 网络错误 backoff
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };

    loop();
  }

  private handleCredentialsExpired(): void {
    this.setStatus({ state: 'reconnecting', error_message: '凭证过期，需要重新扫码' });
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    clearSecrets('ILINK_BOT_TOKEN', 'ILINK_BOT_ID', 'ILINK_USER_ID', 'ILINK_NICKNAME', 'ILINK_GET_UPDATES_BUF');
    this.getUpdatesBuf = '';
    this.contextTokens.clear();
    this.typingTickets.clear();
    // 5s 后自动重新开始扫码
    setTimeout(() => this.start(), 5000);
  }

  private handleMessage(rawMsg: any): void {
    // 跳过非用户消息（不处理 BOT 自己的回显）
    if (rawMsg.message_type === MessageType.BOT) return;

    const contextToken = rawMsg.context_token;
    const fromUserId = rawMsg.from_user_id || 'unknown';
    if (contextToken) this.contextTokens.set(fromUserId, contextToken);

    // 提取文本
    const items = rawMsg.item_list || [];
    let text = '';
    for (const it of items) {
      if (it.type === MessageItemType.TEXT && it.text_item?.text) {
        text += it.text_item.text;
      }
    }

    const msg: WeChatMessage = {
      id: String(rawMsg.message_id ?? Date.now()),
      msg_id: String(rawMsg.message_id ?? Date.now()),
      wxid: fromUserId,
      from_user: fromUserId,
      content: text,
      type: text ? 'text' : 'unknown',
      timestamp: rawMsg.create_time_ms || Date.now(),
      raw: rawMsg,
    };
    this.emit('message', msg);
  }

  // ============= 消息发送 =============

  async sendText(wxid: string, content: string): Promise<string> {
    const secrets = readSecrets();
    const baseUrl = secrets.ILINK_BASE_URL || DEFAULT_BASE_URL;
    const token = secrets.ILINK_BOT_TOKEN;
    if (!token) throw new Error('iLink 未登录');
    const contextToken = this.contextTokens.get(wxid);

    const resp = await sdkSendMessage({
      baseUrl,
      token,
      body: {
        msg: {
          to_user_id: wxid,
          context_token: contextToken,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: content },
            },
          ],
        },
      },
    });
    return String((resp as any).message_id ?? Date.now());
  }

  /**
   * 发送"正在输入"指示器（先 getConfig 拿 typing_ticket，24h 缓存）。
   */
  async sendTypingIndicator(wxid: string, status: 1 | 2 = 1): Promise<void> {
    const secrets = readSecrets();
    const baseUrl = secrets.ILINK_BASE_URL || DEFAULT_BASE_URL;
    const token = secrets.ILINK_BOT_TOKEN;
    if (!token) return;

    let ticketEntry = this.typingTickets.get(wxid);
    if (!ticketEntry || Date.now() - ticketEntry.fetchedAt > 24 * 3600 * 1000) {
      try {
        const cfg = await sdkGetConfig({
          baseUrl,
          token,
          ilinkUserId: wxid,
          contextToken: this.contextTokens.get(wxid),
        });
        if (cfg.typing_ticket) {
          ticketEntry = { ticket: cfg.typing_ticket, fetchedAt: Date.now() };
          this.typingTickets.set(wxid, ticketEntry);
        }
      } catch {
        return; // 拿不到就不发
      }
    }
    if (!ticketEntry) return;
    try {
      await sdkSendTyping({
        baseUrl,
        token,
        body: {
          ilink_user_id: wxid,
          typing_ticket: ticketEntry.ticket,
          status,
        },
      });
    } catch {
      // best-effort
    }
  }

  // ============= ClawAdapter 抽象方法 =============

  async listContacts(): Promise<any[]> {
    // iLink 个人 Bot 不暴露联系人接口（1:1 私聊限制）
    return [];
  }

  async listRooms(): Promise<any[]> {
    // iLink 个人 Bot 不支持群聊
    return [];
  }

  async pollNewMessages(_since?: number): Promise<WeChatMessage[]> {
    // iLink 通过长轮询主动推送，不需兜底轮询
    return [];
  }

  async logout(): Promise<void> {
    const secrets = readSecrets();
    const baseUrl = secrets.ILINK_BASE_URL || DEFAULT_BASE_URL;
    const token = secrets.ILINK_BOT_TOKEN;
    if (token) {
      try {
        await notifyStop({ baseUrl, token });
      } catch {}
    }
    clearSecrets(
      'ILINK_BOT_TOKEN',
      'ILINK_BOT_ID',
      'ILINK_USER_ID',
      'ILINK_NICKNAME',
      'ILINK_GET_UPDATES_BUF'
    );
    this.getUpdatesBuf = '';
    this.contextTokens.clear();
    this.typingTickets.clear();
    await this.stop();
    this.setStatus({ state: 'disconnected', adapter_name: 'ilink' });
  }
}
