import { Request, Response, NextFunction } from 'express';
import { taskQueue } from '../task-queue.js';

/**
 * 全局错误处理中间件（4 参数签名是 Express 识别 error handler 的依据）
 * 统一响应格式：{ success: false, error: '...' }
 * 把 5xx 异常记入系统日志（task.addLog），方便事后排查
 */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const message = err?.message || 'Internal Server Error';

  // 5xx 写日志，4xx 不刷屏
  if (status >= 500) {
    taskQueue.addLog('error', 'server', `[${status}] ${message}`, {
      stack: err?.stack?.split('\n').slice(0, 3).join(' | ')
    });
  }

  // 4xx 不写日志（一般是客户端请求问题），但保留结构
  res.status(status).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err?.stack })
  });
}

/**
 * 异步路由 handler 包装：自动捕获 Promise reject，避免每个路由都写 try/catch
 * 用法：router.get('/x', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<any> | any
) {
  return (req: T, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
