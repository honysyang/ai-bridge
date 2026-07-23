import { startServer } from './server.js';
import { storage } from './storage.js';
import { clawManager } from './claw/index.js';

const PORT = parseInt(process.env.PORT || '4567');

startServer(PORT);

// 优雅关闭：刷新所有未完成的写入
async function gracefulShutdown(signal: string) {
  console.log(`\n收到 ${signal}，正在刷新持久化数据...`);
  try {
    await clawManager.stop();
    await storage.flush();
    console.log('✓ 持久化数据已刷新');
  } catch (e) {
    console.error('刷新失败:', e);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
