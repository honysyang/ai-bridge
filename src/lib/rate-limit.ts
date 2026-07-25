// ======== 登录失败锁定（内存版）========
// v5.5.6: 防止在线暴力破解
//
// 规则：
//   - 按 IP + 用户名 维度统计失败次数
//   - WINDOW_MS 内失败 MAX_ATTEMPTS 次则锁定 LOCKOUT_MS
//   - 登录成功或锁定时间到后重置
//
// 注意：内存版重启后记录丢失；如需持久化可换成 SQLite/redis。

const WINDOW_MS = 5 * 60 * 1000; // 5 分钟窗口
const MAX_ATTEMPTS = 5; // 最大失败次数
const LOCKOUT_MS = 15 * 60 * 1000; // 锁定 15 分钟

interface AttemptRecord {
  count: number;
  firstAt: number;
  lockedUntil?: number;
}

const attempts = new Map<string, AttemptRecord>();

function key(ip: string, username: string): string {
  return `${ip}:${username}`;
}

export function recordFailedAttempt(ip: string, username: string): { locked: boolean; lockedUntil?: number } {
  const k = key(ip, username);
  const now = Date.now();
  const rec = attempts.get(k);

  if (rec && rec.lockedUntil && rec.lockedUntil > now) {
    return { locked: true, lockedUntil: rec.lockedUntil };
  }

  if (!rec || now - rec.firstAt > WINDOW_MS) {
    attempts.set(k, { count: 1, firstAt: now });
    return { locked: false };
  }

  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
    return { locked: true, lockedUntil: rec.lockedUntil };
  }

  return { locked: false };
}

export function recordSuccessfulAttempt(ip: string, username: string): void {
  attempts.delete(key(ip, username));
}

export function isLockedOut(
  ip: string,
  username: string
): { locked: boolean; lockedUntil?: number; remaining?: number } {
  const k = key(ip, username);
  const now = Date.now();
  const rec = attempts.get(k);
  if (rec && rec.lockedUntil && rec.lockedUntil > now) {
    return { locked: true, lockedUntil: rec.lockedUntil };
  }
  if (rec && now - rec.firstAt <= WINDOW_MS) {
    return { locked: false, remaining: Math.max(0, MAX_ATTEMPTS - rec.count) };
  }
  return { locked: false, remaining: MAX_ATTEMPTS };
}
