/**
 * iLink Bot API 客户端（vendor 自 @tencent-weixin/openclaw-weixin@2.4.6）
 *
 * 实现 7 个核心端点:
 *   - getBotQrcode       (扫码登录)
 *   - getQrcodeStatus    (轮询状态)
 *   - getUpdates         (35s 长轮询)
 *   - sendMessage        (发文本/媒体)
 *   - getUploadUrl       (CDN 预签)
 *   - getConfig          (拿 typing_ticket)
 *   - sendTyping         (发"正在输入")
 *
 * 相对原 SDK 的修改:
 *   - import 路径改到本地 shim (./shim.ts) 替代 openclaw 依赖
 *   - 补 TypeScript 类型
 *   - 暴露 getBotQrcode / getQrcodeStatus（这两个原 SDK 在 auth/login-qr.ts，不在 api.ts 中）
 */

import crypto from 'node:crypto';
import { logger, loadConfigBotAgent, loadConfigRouteTag } from './shim.js';
import { redactBody, redactUrl } from './redact.js';
import type {
  BaseInfo,
  GetUpdatesReq,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  NotifyStartResp,
  NotifyStopResp,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
  SendTypingResp,
  GetConfigResp,
} from './types.js';

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  longPollTimeoutMs?: number;
};

// =====================================================================
// Package.json / iLink-App-Id / ClientVersion
// =====================================================================

interface PackageJson {
  name?: string;
  version?: string;
  ilink_appid?: string;
}

function isOwnPackageJson(parsed: PackageJson): boolean {
  if (parsed.ilink_appid !== undefined) return true;
  return typeof parsed.name === 'string' && parsed.name.includes('openclaw-weixin');
}

function readPackageJsonFromDir(_startDir: string): PackageJson {
  // vendor 模式下我们写死 version=2.4.6 / ilink_appid 由 secrets.env 注入
  return {
    name: '@tencent-weixin/openclaw-weixin',
    version: '2.4.6',
    ilink_appid: process.env.ILINK_APP_ID || '',
  };
}

const pkg = readPackageJsonFromDir('.');
const CHANNEL_VERSION = pkg.version ?? 'unknown';
const ILINK_APP_ID = pkg.ilink_appid ?? '';

function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION = buildClientVersion(pkg.version ?? '0.0.0');

const DEFAULT_BOT_AGENT = 'AiBridge/5.0.0';
const BOT_AGENT_MAX_LEN = 256;

export function sanitizeBotAgent(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') return DEFAULT_BOT_AGENT;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;
  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/;
  const rawTokens = trimmed.split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i];
    if (tok.startsWith('(') && !tok.endsWith(')')) {
      let acc = tok;
      while (i + 1 < rawTokens.length && !acc.endsWith(')')) {
        i += 1;
        acc += ' ' + rawTokens[i];
      }
      tokens.push(acc);
    } else {
      tokens.push(tok);
    }
  }
  const accepted: string[] = [];
  let pendingProduct: string | null = null;
  for (const tok of tokens) {
    if (tok.startsWith('(') && tok.endsWith(')')) {
      const inner = tok.slice(1, -1);
      if (pendingProduct && commentCharRe.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`);
        pendingProduct = null;
      } else {
        if (pendingProduct) {
          accepted.push(pendingProduct);
          pendingProduct = null;
        }
      }
      continue;
    }
    if (pendingProduct) {
      accepted.push(pendingProduct);
      pendingProduct = null;
    }
    if (productRe.test(tok)) {
      pendingProduct = tok;
    }
  }
  if (pendingProduct) accepted.push(pendingProduct);
  if (accepted.length === 0) return DEFAULT_BOT_AGENT;
  const joined = accepted.join(' ');
  if (Buffer.byteLength(joined, 'utf-8') <= BOT_AGENT_MAX_LEN) return joined;
  const truncated: string[] = [];
  let len = 0;
  for (const t of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(t, 'utf-8');
    if (len + add > BOT_AGENT_MAX_LEN) break;
    truncated.push(t);
    len += add;
  }
  return truncated.length > 0 ? truncated.join(' ') : DEFAULT_BOT_AGENT;
}

export function buildBaseInfo(): BaseInfo {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(loadConfigBotAgent()),
  };
}

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildCommonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
  const routeTag = loadConfigRouteTag();
  if (routeTag) {
    headers['SKRouteTag'] = routeTag;
  }
  return headers;
}

function buildHeaders(opts: { token?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (opts.token?.trim()) {
    headers['Authorization'] = `Bearer ${opts.token.trim()}`;
  }
  logger.debug(`requestHeaders: ${JSON.stringify({
    ...headers,
    Authorization: headers['Authorization'] ? 'Bearer ***' : undefined,
  })}`);
  return headers;
}

export function classifyFetchError(err: any): {
  type: string;
  description: string;
  code?: string;
} {
  if (err instanceof Error && err.name === 'AbortError') {
    return { type: 'timeout', description: 'request timeout' };
  }
  const cause = err?.cause;
  const causeCode = cause?.code ?? '';
  const causeStr = String(cause ?? err ?? '') + ' ' + String(causeCode);
  const matchedCode = causeCode || (typeof cause === 'string' ? cause : '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(causeStr)) {
    return {
      type: 'dns',
      description: 'DNS resolution failed, check DNS configuration',
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/ECONNREFUSED/i.test(causeStr)) {
    return { type: 'tcp', description: 'TCP connection refused', ...(matchedCode ? { code: matchedCode } : {}) };
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(causeStr)) {
    return {
      type: 'tcp',
      description: 'TCP connection timeout or unreachable',
      ...(matchedCode ? { code: matchedCode } : {}),
    };
  }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(causeStr)) {
    return { type: 'tls', description: 'TLS handshake error', ...(matchedCode ? { code: matchedCode } : {}) };
  }
  return { type: 'unknown', description: 'network request failed' };
}

export type ApiGetFetchParams = {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
};

export type ApiPostFetchParams = {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
  label: string;
  abortSignal?: AbortSignal;
};

export async function apiGetFetch(params: ApiGetFetchParams): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildCommonHeaders();
  logger.debug(`GET ${redactUrl(url.toString())}`);
  const timeoutMs = params.timeoutMs;
  const controller = timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
  const t =
    controller != null && timeoutMs != null ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: hdrs,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    const classified = classifyFetchError(err);
    logger.error(
      `${params.label}: GET fetch failed url=${redactUrl(url.toString())} timeoutMs=${
        timeoutMs ?? 'none'
      } type=${classified.type} description=${classified.description}${
        classified.code ? ` code=${classified.code}` : ''
      } error=${String(err)}`
    );
    throw err;
  }
}

function combineAbortSignals(params: {
  internal?: AbortController;
  external?: AbortSignal;
}): { signal: AbortSignal | undefined; cleanup: () => void } {
  const { internal, external } = params;
  if (!external) {
    return { signal: internal?.signal, cleanup: () => {} };
  }
  if (!internal) {
    return { signal: external, cleanup: () => {} };
  }
  if (external.aborted) {
    internal.abort();
    return { signal: internal.signal, cleanup: () => {} };
  }
  const onExternalAbort = () => internal.abort();
  external.addEventListener('abort', onExternalAbort, { once: true });
  return {
    signal: internal.signal,
    cleanup: () => external.removeEventListener('abort', onExternalAbort),
  };
}

export async function apiPostFetch(params: ApiPostFetchParams): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token });
  logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);
  const controller = params.timeoutMs !== undefined ? new AbortController() : undefined;
  const t =
    controller != null && params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  const { signal, cleanup } = combineAbortSignals({
    internal: controller,
    external: params.abortSignal,
  });
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: hdrs,
      body: params.body,
      ...(signal ? { signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    const classified = classifyFetchError(err);
    logger.error(
      `${params.label}: POST fetch failed url=${redactUrl(url.toString())} timeoutMs=${
        params.timeoutMs ?? 'none'
      } type=${classified.type} description=${classified.description}${
        classified.code ? ` code=${classified.code}` : ''
      } error=${String(err)}`
    );
    throw err;
  } finally {
    cleanup();
  }
}

// =====================================================================
// 登录流程（vendor 自 auth/login-qr.ts）
// =====================================================================

export type GetBotQrcodeResp = {
  qrcode: string;
  qrcode_img_content: string; // 完整的 https URL
  expires_at?: number;
};

export async function getBotQrcode(params: { baseUrl: string; botType?: number; timeoutMs?: number }): Promise<GetBotQrcodeResp> {
  const botType = params.botType ?? 3;
  const rawText = await apiGetFetch({
    baseUrl: params.baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${botType}`,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getBotQrcode',
  });
  const resp = JSON.parse(rawText);
  return resp;
}

export type GetQrcodeStatusResp = {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
};

export async function getQrcodeStatus(params: {
  baseUrl: string;
  qrcode: string;
  timeoutMs?: number;
}): Promise<GetQrcodeStatusResp> {
  const rawText = await apiGetFetch({
    baseUrl: params.baseUrl,
    endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getQrcodeStatus',
  });
  return JSON.parse(rawText);
}

// =====================================================================
// 业务端点
// =====================================================================

export type GetUpdatesParams = {
  baseUrl: string;
  token: string;
  get_updates_buf?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export async function getUpdates(params: GetUpdatesParams): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? '',
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: 'getUpdates',
      abortSignal: params.abortSignal,
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    // v5.2.1: 更宽松的 abort 检测
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
    if (isAbort) {
      if (params.abortSignal?.aborted) {
        logger.debug(`getUpdates: aborted by external signal`);
      } else {
        logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
      }
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

export type GetUploadUrlParams = {
  baseUrl: string;
  token: string;
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
  timeoutMs?: number;
};

export async function getUploadUrl(params: GetUploadUrlParams): Promise<GetUploadUrlResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'getUploadUrl',
  });
  return JSON.parse(rawText) as GetUploadUrlResp;
}

export type SendMessageParams = {
  baseUrl: string;
  token: string;
  body: SendMessageReq;
  timeoutMs?: number;
};

export async function sendMessage(params: SendMessageParams): Promise<SendMessageResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'sendMessage',
  });
  const resp = JSON.parse(rawText) as SendMessageResp;
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`);
  }
  return resp;
}

export type GetConfigParams = {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken?: string;
  timeoutMs?: number;
};

export async function getConfig(params: GetConfigParams): Promise<GetConfigResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getConfig',
  });
  return JSON.parse(rawText) as GetConfigResp;
}

export type SendTypingParams = {
  baseUrl: string;
  token: string;
  body: SendTypingReq;
  timeoutMs?: number;
};

export async function sendTyping(params: SendTypingParams): Promise<SendTypingResp> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'sendTyping',
  });
  return { ret: 0 };
}

export async function notifyStop(params: { baseUrl: string; token: string; timeoutMs?: number }): Promise<NotifyStopResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/msg/notifystop',
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'notifyStop',
  });
  return JSON.parse(rawText) as NotifyStopResp;
}

export async function notifyStart(params: { baseUrl: string; token: string; timeoutMs?: number }): Promise<NotifyStartResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'notifyStart',
  });
  return JSON.parse(rawText) as NotifyStartResp;
}

// Re-export SDK 类型便于外部使用
export type { GetUpdatesReq, GetUpdatesResp };
