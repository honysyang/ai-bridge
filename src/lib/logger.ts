/**
 * 运行时诊断日志（v5.2.0 引入 winston）
 *
 * 与 taskQueue.addLog 的边界：
 * - taskQueue.addLog：业务事件，写 JSONL 持久化，供 Web UI 查询（任务/会话/知识库相关）
 * - logger.*      ：运行时诊断，写 console + 文件，仅给运维/开发看（HTTP/WS/启动/错误）
 *
 * 双轨制：业务事件仍走 taskQueue.addLog（不动），运行时诊断改走 winston
 *
 * 配置：
 * - 级别：LOG_LEVEL 环境变量，默认 'info'
 * - 控制台：带颜色，按级别过滤
 * - 文件：logs/ai-bridge-YYYY-MM-DD.log（按日切分），保留 14 天
 * - 错误文件：logs/ai-bridge-error-YYYY-MM-DD.log（只存 error 级），保留 30 天
 */

import winston from 'winston';
import 'winston-daily-rotate-file';
import * as path from 'path';
import * as fs from 'fs';
import { LOGS_DIR } from './paths.js';

// 确保 logs 目录存在
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// 通用格式：timestamp + level + message + meta
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// 控制台格式：带颜色 + 简明
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} ${level} ${message}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: fileFormat,
  defaultMeta: { service: 'ai-bridge' },
  transports: [
    // 控制台（开发/排错）
    new winston.transports.Console({
      format: consoleFormat,
      silent: process.env.NODE_ENV === 'test' // 测试环境静默
    }),
    // 全量日志（按日切分）
    new winston.transports.DailyRotateFile({
      filename: path.join(LOGS_DIR, 'ai-bridge-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      maxSize: '20m',
      format: fileFormat
    }),
    // 错误日志（独立文件，方便告警）
    new winston.transports.DailyRotateFile({
      filename: path.join(LOGS_DIR, 'ai-bridge-error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '30d',
      maxSize: '20m',
      format: fileFormat
    })
  ],
  // 未捕获异常不退出进程（保留原 process 行为）
  exitOnError: false
});

/**
 * 子日志器：给特定模块/上下文打标签
 * 用法：const log = logger.child({ module: 'wechat-bridge' });
 */
export function childLogger(meta: Record<string, any>) {
  return logger.child(meta);
}

/**
 * 便捷：记录 HTTP 请求
 */
export function logRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  meta?: Record<string, any>
) {
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  logger.log(level, `${method} ${path} ${status} ${durationMs}ms`, {
    http: true,
    method,
    path,
    status,
    durationMs,
    ...meta
  });
}
