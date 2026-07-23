// ======== 微信 Claw 类型定义 (v4.1.0) ========
//
// v4.1.0 变更: 移除 gewechat 字段，全面切换到 iLink Bot API。

// 连接状态机
export type ClawConnectionState =
  | 'disconnected'   // 未启动 / 已退出
  | 'qrcode'         // 等待扫码
  | 'connecting'     // 扫码后连接中
  | 'connected'      // 已登录
  | 'reconnecting'   // 掉线重连中
  | 'banned'         // 封号
  | 'error';         // 异常

export interface ClawStatus {
  state: ClawConnectionState;
  qrcode_url?: string;          // base64 dataURL 或 https URL，前端直接 <img src>
  qrcode_expires_at?: number;   // ms timestamp
  wxid?: string;                // 登录后的 bot_id
  nickname?: string;            // 昵称
  avatar_url?: string;          // 头像 URL（可选）
  phone?: string;               // 手机号（如有）
  connected_at?: number;        // 首次连接时间
  last_heartbeat_at?: number;   // 最近一次心跳
  error_message?: string;       // 异常信息
  adapter_name?: string;        // 固定 'ilink'
  adapter_version?: string;     // iLink SDK 版本
}

// ======== 微信消息 ========

export type WeChatMessageType = 'text' | 'image' | 'file' | 'voice' | 'system' | 'unknown';

export interface WeChatMessage {
  id: string;                  // 内部 ID（= message_id）
  msg_id: string;              // iLink 返回的 message_id
  wxid: string;                // 发送者 ilink user id
  room_wxid?: string;          // 群 wxid（群聊时存在，iLink 个人 Bot 通常为空）
  from_user: string;           // 发送者昵称
  content: string;             // 文本内容
  type: WeChatMessageType;     // 消息类型
  timestamp: number;           // ms
  raw?: any;                   // iLink 原始 payload（调试用）
}

// ======== 联系人/群聊 ========
// iLink 个人 Bot 不暴露联系人/群聊接口，预留兼容字段

export type WeChatContactType = 'friend' | 'group' | 'official' | 'self';

export interface WeChatContact {
  wxid: string;
  nickname: string;
  remark?: string;
  avatar_url?: string;
  type: WeChatContactType;
  signature?: string;
  last_active?: number;
  member_count?: number;
}

// ======== 配置 ========
// iLink 不需要 base_url / callback_url 等，本结构保留以兼容 server / 前端
// 凭证实际存 ~/.config/agent-canvas/secrets.env
//   ILINK_BASE_URL=https://ilinkai.weixin.qq.com
//   ILINK_BOT_TOKEN=xxx
//   ILINK_BOT_ID=xxx
//   ILINK_USER_ID=xxx

export interface ClawConfig {
  enabled: boolean;                 // 总开关
  auto_reply: boolean;              // 任务完成后自动回微信
  message_dedup_ttl_ms: number;     // 消息去重窗口
  base_url?: string;                // iLink 兼容字段（实际从 secrets.env 读）
  callback_url?: string;            // 兼容字段（iLink 不用 webhook）
  poll_interval_ms?: number;        // 兼容字段（iLink 用长轮询）
  reconnect_max_retries?: number;   // 兼容字段
  api_token?: string;               // 兼容字段
}

export const DEFAULT_CLAW_CONFIG: ClawConfig = {
  enabled: true,
  auto_reply: true,
  message_dedup_ttl_ms: 300000,
};

// ======== 事件类型 ========

export interface ClawEvents {
  status: (status: ClawStatus) => void;
  qrcode: (data: { qrcode_url: string; expires_at: number }) => void;
  message: (msg: WeChatMessage) => void;
  error: (err: Error) => void;
}
