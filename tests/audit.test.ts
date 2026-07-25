import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('audit', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = path.join(os.tmpdir(), `aibridge-audit-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'secrets'), { recursive: true });
    process.env.AIBRIDGE_DATA_DIR = tmpDir;
    process.env.AIBRIDGE_SECRETS_DIR = path.join(tmpDir, 'secrets');
    // 日志保持默认 logs/，避免 winston 文件句柄在删除 tmpDir 后报错
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('writeAudit + readAudit 可正确写入与读取', async () => {
    const { writeAudit, readAudit } = await import('../src/lib/audit.js');

    writeAudit({
      action: 'auth:login:success',
      actor: { id: 'u-1', username: 'admin', role: 'admin' },
      ip: '127.0.0.1',
      target: 'u-1'
    });

    const entries = readAudit({ limit: 10 });
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe('auth:login:success');
    expect(entries[0].actor?.username).toBe('admin');
    expect(entries[0].ip).toBe('127.0.0.1');
  });

  it('readAudit 支持按 action 过滤', async () => {
    const { writeAudit, readAudit } = await import('../src/lib/audit.js');

    writeAudit({ action: 'auth:login:failed', actor: { username: 'hacker' }, ip: '10.0.0.1' });
    writeAudit({ action: 'auth:login:success', actor: { username: 'admin' }, ip: '127.0.0.1' });

    const failed = readAudit({ action: 'auth:login:failed' });
    expect(failed.length).toBe(1);
    expect(failed[0].actor?.username).toBe('hacker');
  });
});
