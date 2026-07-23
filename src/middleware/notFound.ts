import { Request, Response, NextFunction } from 'express';

/**
 * 404 兜底：所有路由都没匹配时进入这里
 * 统一响应格式：{ success: false, error: 'Not Found', path }
 */
export function notFoundHandler(req: Request, res: Response, _next: NextFunction) {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    path: req.path,
    method: req.method
  });
}
