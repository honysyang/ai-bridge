import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';

describe('paths', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.AIBRIDGE_DATA_DIR;
    delete process.env.AIBRIDGE_LOGS_DIR;
    delete process.env.AIBRIDGE_SECRETS_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('默认使用 cwd/data 作为数据目录', async () => {
    const { DATA_DIR } = await import('../src/lib/paths.js');
    expect(DATA_DIR).toBe(path.resolve(process.cwd(), 'data'));
  });

  it('AIBRIDGE_DATA_DIR 环境变量可覆盖数据目录', async () => {
    const customDir = path.join(os.tmpdir(), `aibridge-test-data-${Date.now()}`);
    process.env.AIBRIDGE_DATA_DIR = customDir;
    const { DATA_DIR } = await import('../src/lib/paths.js');
    expect(DATA_DIR).toBe(path.resolve(customDir));
  });

  it('支持 ~ 作为家目录前缀', async () => {
    process.env.AIBRIDGE_SECRETS_DIR = '~/.config/aibridge-test';
    const { SECRETS_DIR } = await import('../src/lib/paths.js');
    expect(SECRETS_DIR).toBe(path.resolve(path.join(os.homedir(), '.config', 'aibridge-test')));
  });
});
