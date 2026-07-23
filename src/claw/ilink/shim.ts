/**
 * Logger + accounts shim for vendor SDK in ai-bridge.
 *
 * SDK 原始实现依赖 openclaw peerDependency（plugin-sdk/infra-runtime 等）。
 * 这里用最小化的本地实现替代，让 SDK 能在 ai-bridge 中独立运行。
 *
 * 行为对照:
 *   - logger.debug/info/warn/error       → 写入 data/logs/ilink-YYYY-MM-DD.log（JSONL）
 *   - logger.withAccount(id).info(...)   → 账号前缀日志
 *   - logger.getLogFilePath()            → 当前日志文件路径
 *   - logger.close()                     → 关闭文件句柄
 *   - loadConfigBotAgent()               → 从 secrets.env ILINK_BOT_AGENT 读，缺省 "AiBridge/5.0.0"
 *   - loadConfigRouteTag()               → 从 secrets.env ILINK_ROUTE_TAG 读，缺省 ""
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LOG_DIR = path.join(process.cwd(), 'data', 'logs');
const SUBSYSTEM = 'claw/ilink';

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function localDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resolveLogPath(): string {
  return path.join(LOG_DIR, `ilink-${localDateKey()}.log`);
}

function writeLine(level: string, message: string, accountId?: string): void {
  try {
    ensureLogDir();
    const loggerName = accountId ? `${SUBSYSTEM}/${accountId}` : SUBSYSTEM;
    const prefixedMessage = accountId ? `[${accountId}] ${message}` : message;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      logger: loggerName,
      host: os.hostname() || 'unknown',
      message: prefixedMessage,
    });
    fs.appendFileSync(resolveLogPath(), `${entry}\n`, 'utf-8');
  } catch {
    // best-effort
  }
}

export interface IlinkLogger {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  withAccount(id: string): IlinkLogger;
  getLogFilePath(): string;
  close(): void;
}

function createLogger(accountId?: string): IlinkLogger {
  return {
    info: (m) => writeLine('INFO', m, accountId),
    debug: (m) => writeLine('DEBUG', m, accountId),
    warn: (m) => writeLine('WARN', m, accountId),
    error: (m) => writeLine('ERROR', m, accountId),
    withAccount: (id) => createLogger(id),
    getLogFilePath: () => resolveLogPath(),
    close: () => {
      // no-op
    },
  };
}

export const logger: IlinkLogger = createLogger();

// =====================================================================
// Accounts shim — 从 ~/.config/agent-canvas/secrets.env 读取 iLink 配置
// =====================================================================

const SECRETS_FILE = path.join(os.homedir(), '.config', 'agent-canvas', 'secrets.env');

function loadSecretsEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    if (!fs.existsSync(SECRETS_FILE)) return result;
    const content = fs.readFileSync(SECRETS_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      result[key] = value;
    }
  } catch {
    // best-effort
  }
  return result;
}

// 模块级缓存，进程内读一次
const secretsCache: Record<string, string> = loadSecretsEnv();

/** bot_agent 字段（UA 风格的标识串）。 */
export function loadConfigBotAgent(): string {
  return secretsCache.ILINK_BOT_AGENT || 'AiBridge/5.0.0';
}

/** 可选路由标签（用于灰度/分桶）。 */
export function loadConfigRouteTag(): string {
  return secretsCache.ILINK_ROUTE_TAG || '';
}

/** 重新加载 secrets.env（用于运行时改完凭证后立即生效）。 */
export function reloadSecrets(): void {
  const fresh = loadSecretsEnv();
  for (const k of Object.keys(secretsCache)) delete secretsCache[k];
  Object.assign(secretsCache, fresh);
}
