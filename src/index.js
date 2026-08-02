import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAll } from './storage.js';
import { initAuth } from './auth.js';
import { createServer } from './server.js';
import { clawManager } from './claw/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4567);
const DATA_DIR = process.env.AIBRIDGE_DATA_DIR || path.join(ROOT, 'data');

const store = await loadAll(DATA_DIR);
initAuth(store);
const { app, ctx } = await createServer(store);

app.listen(PORT, () => {
  console.log(`🦩 鹤仙人 ai-bridge v7.0.0 已启动: http://localhost:${PORT}`);
  console.log(`   数据目录: ${DATA_DIR}`);
  if (process.env.ILINK_MOCK === '1') console.log('   🧪 微信适配器：mock 模式（演示）');
  else console.log('   📡 微信适配器：iLink（真实接入，待扫码激活）');
  store.log('info', 'system', `服务启动，端口 ${PORT}`);
});

// 启动微信 Claw（如有凭证或 mock 模式）
try { await clawManager.start(ctx); }
catch (e) { store.log('error', 'claw', `adapter 启动失败: ${e.message}`); }

// 优雅退出
process.on('SIGINT', async () => { await clawManager.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await clawManager.stop(); process.exit(0); });

// 定时任务调度器：每 30s 检查一次（模块存在才启用）
const schedFile = path.join(__dirname, 'routes', 'schedules.js');
if (fs.existsSync(schedFile)) {
  const mod = await import('./routes/schedules.js');
  if (typeof mod.tick === 'function') {
    setInterval(() => {
      try { mod.tick(ctx); } catch (e) { store.log('error', 'scheduler', e.message); }
    }, 30_000);
  }
}

// 每日订阅调度器：每 30s 检查到点订阅（模块存在才启用，复用同一 tick 体系）
const subFile = path.join(__dirname, 'routes', 'subscriptions.js');
if (fs.existsSync(subFile)) {
  const subMod = await import('./routes/subscriptions.js');
  if (typeof subMod.tick === 'function') {
    setInterval(() => {
      try { subMod.tick(ctx); } catch (e) { store.log('error', 'subscriptions', e.message); }
    }, 30_000);
  }
}
