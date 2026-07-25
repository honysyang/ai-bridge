import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Task } from '../src/types.js';

describe('storage write error propagation', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = path.join(os.tmpdir(), `aibridge-storage-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'secrets'), { recursive: true });
    process.env.AIBRIDGE_DATA_DIR = tmpDir;
    process.env.AIBRIDGE_SECRETS_DIR = path.join(tmpDir, 'secrets');
    process.env.AIBRIDGE_SQLITE_SYNC = '0';
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

  function makeTask(id: string): Task {
    return {
      id,
      type: 'chat',
      priority: 'normal',
      source: 'manual',
      data: { content: `test-${id}`, from_user: 'test' },
      created_at: Date.now(),
      status: 'pending'
    };
  }

  it('appendTask 在磁盘写入失败时应向上抛出错误', async () => {
    const { storage } = await import('../src/storage.js');

    // 第一次写入成功，确保文件已创建
    await storage.appendTask(makeTask('task-test-1'));

    // 模拟磁盘满：下一次 appendFile 抛出错误
    const error = new Error('disk full');
    const spy = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(error);

    await expect(storage.appendTask(makeTask('task-test-2'))).rejects.toThrow('disk full');

    // 失败不应阻塞后续写入：队列继续前进
    spy.mockRestore();
    await expect(storage.appendTask(makeTask('task-test-3'))).resolves.toBeUndefined();
  });
});
