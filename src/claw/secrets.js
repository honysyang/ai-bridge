// secrets.js —— 凭证管理：<data>/secrets.env
// 用途：iLink Bot 凭证（ILINK_BASE_URL / ILINK_BOT_TOKEN / ILINK_BOT_ID / ILINK_USER_ID 等）
// 安全：文件权限 600，写入时 chmod 双保险
//      路径由环境变量 AIBRIDGE_DATA_DIR 指定（与项目 data 目录同源），便于备份和迁移
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.AIBRIDGE_DATA_DIR || path.join(process.cwd(), 'data');
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');
const SECRETS_FILE = path.join(SECRETS_DIR, 'ilink.env');

function ensureDir() {
  if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(SECRETS_DIR, 0o700); } catch { /* ignore */ }
}

function parse(content) {
  const out = {};
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    out[k] = v;
  }
  return out;
}

function serialize(obj) {
  const lines = [
    '# ai-bridge v7 — 本地凭证管理（自动维护，请勿手改）',
    '# Permissions: 600 (chmod)',
    '',
  ];
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v == null) continue;
    lines.push(/[\s"'#=]/.test(v) ? `${k}="${v.replace(/"/g, '\\"')}"` : `${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

export function readSecrets() {
  try {
    if (!fs.existsSync(SECRETS_FILE)) return {};
    return parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
  } catch { return {}; }
}

export function writeSecrets(updates) {
  try {
    ensureDir();
    const merged = { ...readSecrets(), ...updates };
    const content = serialize(merged);
    fs.writeFileSync(SECRETS_FILE, content, { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* ignore */ }
    return true;
  } catch (e) {
    console.error('[secrets] 写入失败:', e.message);
    return false;
  }
}

export function clearSecrets(...keys) {
  try {
    const cur = readSecrets();
    for (const k of keys) delete cur[k];
    fs.writeFileSync(SECRETS_FILE, serialize(cur), { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

export function hasIlinkCredentials() {
  const s = readSecrets();
  return !!(s.ILINK_BOT_TOKEN && s.ILINK_BOT_ID && s.ILINK_USER_ID);
}

export { SECRETS_DIR, SECRETS_FILE };
