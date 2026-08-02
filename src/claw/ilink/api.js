// ilink/api.js —— iLink Bot 8 端点 HTTP 客户端（v7 简化移植自 v6）
// 协议：腾讯 iPad iLink 协议（@tencent-weixin/openclaw-weixin 协议族）
// 8 端点：
//   getBotQrcode / getQrcodeStatus / getUpdates / sendMessage
//   getUploadUrl / getConfig / sendTyping / notifyStart / notifyStop
import crypto from 'node:crypto';
import { appendLog, getSecrets, getAppId } from './shim.js';

const CHANNEL_VERSION = '7.0.0';
const ILINK_APP_ID = getAppId();

function buildClientVersion(version) {
  const [maj = 0, min = 0, pat = 0] = version.split('.').map((p) => parseInt(p, 10));
  return ((maj & 0xff) << 16) | ((min & 0xff) << 8) | (pat & 0xff);
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

function randomWechatUin() {
  const u32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(u32), 'utf-8').toString('base64');
}

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: 'AiBridge/7.0.0' };
}

function commonHeaders(token) {
  const h = {
    'Content-Type': 'application/json',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function apiGet(baseUrl, endpoint, timeoutMs = 10000) {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  appendLog('debug', 'ilink', `GET ${url.pathname}`);
  try {
    const res = await fetch(url.toString(), { method: 'GET', signal: ac.signal });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } finally { clearTimeout(t); }
}

async function apiPost(baseUrl, endpoint, body, token, timeoutMs = 15000) {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  appendLog('debug', 'ilink', `POST ${url.pathname} token=${token ? token.slice(0, 6) + '…' : 'none'}`);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST', signal: ac.signal,
      headers: commonHeaders(token), body: body || '{}',
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } finally { clearTimeout(t); }
}

/* ==================== 登录：扫码 ==================== */
export async function getBotQrcode(baseUrl, botType = 3, timeoutMs = 10000) {
  const text = await apiGet(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${botType}`, timeoutMs);
  return JSON.parse(text); // { qrcode, qrcode_img_content, expires_at? }
}

export async function getQrcodeStatus(baseUrl, qrcode, timeoutMs = 10000) {
  const text = await apiGet(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, timeoutMs);
  return JSON.parse(text); // { status, bot_token?, baseurl?, ilink_bot_id?, ilink_user_id? }
}

/* ==================== 长轮询：拿消息 ==================== */
export async function getUpdates(baseUrl, token, getUpdatesBuf = '', timeoutMs = 35000) {
  let ac;
  try {
    ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const body = JSON.stringify({ get_updates_buf: getUpdatesBuf, base_info: buildBaseInfo() });
    const url = new URL('ilink/bot/getupdates', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    appendLog('debug', 'ilink', `getUpdates buf.len=${getUpdatesBuf.length}`);
    const res = await fetch(url.toString(), {
      method: 'POST', signal: ac.signal,
      headers: commonHeaders(token), body,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      // 长轮询超时：返回空（上层继续轮询）
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/* ==================== 发消息 ====================
 * 简化版：只发文本（type=1 文本 / type=2 图片 / type=3 语音 / type=4 视频 / type=5 文件 / type=6 表情）
 */
export async function sendMessage(baseUrl, token, msg) {
  const body = JSON.stringify({ msg, base_info: buildBaseInfo() });
  const text = await apiPost(baseUrl, 'ilink/bot/sendmessage', body, token, 15000);
  const resp = JSON.parse(text);
  if (resp.ret !== undefined && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg || '(none)'}`);
  }
  return resp;
}

/** 构造一条文本消息（to_user_id = 群 id 或好友 id） */
export function buildTextMessage({ toUserId, text, clientMsgId, fromUserId }) {
  return {
    from_user_id: fromUserId || '',
    to_user_id: toUserId,
    client_id: clientMsgId || `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    create_time_ms: Date.now(),
    message_type: 1, // 1=文本
    message_state: 0,
    item_list: [{
      type: 1, create_time_ms: Date.now(), is_completed: true,
      text_item: { text: String(text) },
    }],
  };
}

/* ==================== CDN 上传预签（v7 暂不实现，保留接口）==================== */
export async function getUploadUrl(baseUrl, token, params) {
  const body = JSON.stringify({ ...params, base_info: buildBaseInfo() });
  const text = await apiPost(baseUrl, 'ilink/bot/getuploadurl', body, token, 15000);
  return JSON.parse(text);
}

/* ==================== 拿 typing_ticket ==================== */
export async function getConfig(baseUrl, token, ilinkUserId, contextToken) {
  const body = JSON.stringify({
    ilink_user_id: ilinkUserId, context_token: contextToken, base_info: buildBaseInfo(),
  });
  const text = await apiPost(baseUrl, 'ilink/bot/getconfig', body, token, 10000);
  return JSON.parse(text);
}

/* ==================== "正在输入" 指示 ==================== */
export async function sendTyping(baseUrl, token, ilinkUserId, typingTicket, status = 1) {
  const body = JSON.stringify({
    ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: buildBaseInfo(),
  });
  const text = await apiPost(baseUrl, 'ilink/bot/sendtyping', body, token, 10000);
  return JSON.parse(text);
}

/* ==================== 通知 bot 启动/停止 ==================== */
export async function notifyStart(baseUrl, token) {
  const body = JSON.stringify({ base_info: buildBaseInfo() });
  const text = await apiPost(baseUrl, 'ilink/bot/notifystart', body, token, 10000);
  return JSON.parse(text);
}
export async function notifyStop(baseUrl, token) {
  const body = JSON.stringify({ base_info: buildBaseInfo() });
  const text = await apiPost(baseUrl, 'ilink/bot/notifystop', body, token, 10000);
  return JSON.parse(text);
}

/* ==================== 工具：从 secrets 推断 baseUrl ==================== */
export function resolveBaseUrl() {
  const s = getSecrets();
  return s.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com';
}
