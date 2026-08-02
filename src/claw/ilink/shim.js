// shim.js —— iLink 适配器所需的本地支撑
// 1. secrets 读取（凭证）
// 2. 日志输出（写到 data/logs/ilink-YYYY-MM-DD.log JSONL）
// 3. 内存 secrets 缓存（避免反复读盘）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSecrets } from '../secrets.js';

const DATA_DIR = process.env.AIBRIDGE_DATA_DIR || path.join(process.cwd(), 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function localDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resolveLogPath() {
  return path.join(LOG_DIR, `ilink-${localDateKey()}.log`);
}

function appendLog(level, logger, message) {
  try {
    ensureLogDir();
    const entry = JSON.stringify({
      ts: new Date().toISOString(), level,
      logger: `claw/ilink/${logger}`,
      host: os.hostname() || 'unknown', message,
    });
    fs.appendFileSync(resolveLogPath(), entry + '\n', 'utf-8');
    // 调试期同步输出到控制台
    if (process.env.ILINK_DEBUG || level === 'error') {
      console.log(`[ilink/${level}] ${message}`);
    }
  } catch { /* best-effort */ }
}

let _secretsCache = null;
let _secretsCacheAt = 0;
const CACHE_TTL_MS = 1000;
export function getSecrets() {
  const now = Date.now();
  if (!_secretsCache || now - _secretsCacheAt > CACHE_TTL_MS) {
    _secretsCache = readSecrets();
    _secretsCacheAt = now;
  }
  return _secretsCache;
}
export function reloadSecrets() {
  _secretsCache = null;
}

export function getAppId() {
  return process.env.ILINK_APP_ID || getSecrets().ILINK_APP_ID || '';
}

export { appendLog };
