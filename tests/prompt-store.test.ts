import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('prompt-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join('/tmp', `aibridge-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.AIBRIDGE_DATA_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    // 让前一个 store 的异步写入完成，避免删除目录后写入报错
    await new Promise((r) => setTimeout(r, 50));
    delete process.env.AIBRIDGE_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function getStore() {
    const mod = await import('../src/prompt-store.js');
    return new mod.PromptStore();
  }

  it('should seed demo on first load', async () => {
    const store = await getStore();
    const result = store.loadAll();
    expect(result.seeded).toBe(true);
    expect(result.categories).toBeGreaterThan(0);
    expect(result.prompts).toBeGreaterThan(0);
  });

  it('should create category and prompt', async () => {
    const store = await getStore();
    store.loadAll();
    const cat = store.createCategory('测试分类', '🧪');
    expect(cat.name).toBe('测试分类');
    const prompt = store.createPrompt(cat.id, 'hello {{name}}', 'say hi to {{name}}');
    expect(prompt).not.toBeNull();
    expect(prompt?.variables).toContain('name');
  });

  it('should apply variables and report missing', async () => {
    const store = await getStore();
    store.loadAll();
    const cat = store.createCategory('apply');
    const prompt = store.createPrompt(cat.id, 'greeting', 'Hello {{name}}, welcome to {{city}}!');
    const result = store.apply(prompt!.id, { name: 'Alice' });
    expect(result?.rendered).toBe('Hello Alice, welcome to {{city}}!');
    expect(result?.missing).toContain('city');
  });

  it('should persist across loadAll', async () => {
    const store1 = await getStore();
    store1.loadAll();
    const cat = store1.createCategory('持久化');
    const prompt = store1.createPrompt(cat.id, 'p', 'content {{x}}');

    // 等待异步写入完成
    await store1.flush();

    const store2 = await getStore();
    store2.loadAll();
    expect(store2.getCategory(cat.id)?.name).toBe('持久化');
    await store2.flush();
    expect(store2.getPrompt(prompt!.id)?.content).toBe('content {{x}}');
  });
});
