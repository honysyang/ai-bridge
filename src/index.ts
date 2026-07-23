import { startServer } from './server.js';
import { storage } from './storage.js';
import { clawManager } from './claw/index.js';
import { logger } from './lib/logger.js';

const PORT = parseInt(process.env.PORT || '4567');

startServer(PORT);

// 优雅关闭：刷新所有未完成的写入
async function gracefulShutdown(signal: string) {
  logger.info(`收到 ${signal}，正在刷新持久化数据...`);
  try {
    await clawManager.stop();
    await storage.flush();
    logger.info('✓ 持久化数据已刷新');
  } catch (e: any) {
    logger.error('刷新失败', { error: e.message });
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
