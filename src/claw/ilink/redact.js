// redact.js —— 日志脱敏（token / authorization / context_token）
const DEFAULT_BODY_MAX = 200;
const DEFAULT_PREFIX = 6;

export function truncate(s, max) {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…(len=${s.length})`;
}

export function redactToken(token, prefixLen = DEFAULT_PREFIX) {
  if (!token) return '(none)';
  if (token.length <= prefixLen) return `****(len=${token.length})`;
  return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}

export function redactBody(body, maxLen = DEFAULT_BODY_MAX) {
  if (!body) return '(empty)';
  const redacted = body.replace(
    /"(context_token|bot_token|token|authorization|Authorization)"\s*:\s*"[^"]*"/g,
    '"$1":"<redacted>"'
  );
  return redacted.length <= maxLen ? redacted : `${redacted.slice(0, maxLen)}…(truncated)`;
}

export function redactUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.search ? `${u.origin}${u.pathname}?<redacted>` : `${u.origin}${u.pathname}`;
  } catch { return truncate(rawUrl, 80); }
}
