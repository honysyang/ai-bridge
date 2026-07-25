import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { Request, Response, NextFunction } from 'express';

function mockRes(): Response {
  const res: any = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res as Response;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    originalUrl: '/api/tasks',
    url: '/api/tasks',
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' } as any,
    headers: {},
    cookies: {},
    body: {},
    ...overrides
  } as Request;
}

describe('auth local bypass', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = path.join(os.tmpdir(), `aibridge-auth-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'secrets'), { recursive: true });
    process.env.AIBRIDGE_DATA_DIR = tmpDir;
    process.env.AIBRIDGE_SECRETS_DIR = path.join(tmpDir, 'secrets');
    // 日志保持默认 logs/，避免 winston 文件句柄在删除 tmpDir 后报错
    process.env.AIBRIDGE_LOCAL_NETWORKS = '127.0.0.1,::1';
    process.env.AIBRIDGE_JWT_SECRET = 'test-secret-for-auth-tests';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('本地 127.0.0.1 请求应直接放行', async () => {
    const { requireAuth } = await import('../src/middleware/auth.js');
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeUndefined();
  });

  it('非本地 IP 无 token 应返回 401', async () => {
    const { requireAuth } = await import('../src/middleware/auth.js');
    const req = mockReq({ socket: { remoteAddress: '192.168.1.100' } as any });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('AIBRIDGE_LOCAL_NETWORKS 支持 CIDR', async () => {
    process.env.AIBRIDGE_LOCAL_NETWORKS = '192.168.0.0/16';
    const { requireAuth } = await import('../src/middleware/auth.js');
    const req = mockReq({ socket: { remoteAddress: '192.168.1.50' } as any });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
