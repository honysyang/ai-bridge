// ======== API 限流（内存版）========
// v5.5.6: 保护公开端点和登录接口，防止暴力破解 / DoS
//
// 规则：
//   - 按 IP 维度统计
//   - WINDOW_MS 内超过 MAX_REQUESTS 则 429
//   - 内存版重启后清零；生产环境建议接 redis

import { Request, Response, NextFunction } from 'express';

interface RateRecord {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60 * 1000; // 1 分钟窗口

class RateLimiter {
  private records = new Map<string, RateRecord>();
  private maxRequests: number;

  constructor(maxRequests: number) {
    this.maxRequests = maxRequests;
  }

  middleware(req: Request, res: Response, next: NextFunction) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = this.records.get(ip);
    if (!rec || now > rec.resetAt) {
      this.records.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return next();
    }
    rec.count++;
    if (rec.count > this.maxRequests) {
      res.setHeader('Retry-After', Math.ceil((rec.resetAt - now) / 1000));
      return res.status(429).json({ success: false, error: '请求过于频繁，请稍后再试' });
    }
    next();
  }
}

export const publicRateLimiter = new RateLimiter(120); // 公开端点：120/min
export const authRateLimiter = new RateLimiter(10); // 登录/认证：10/min
