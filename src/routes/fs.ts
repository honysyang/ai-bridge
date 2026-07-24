// ======== v5.4.5: 文件系统补全 API ========
//
// 提供"项目目录"输入的实时补全，类似 shell 的 tab 补全。
// - 路径长度限制 1024
// - 只读（不写盘）
// - 返回数量限制 12
// - 隐藏目录和敏感目录不返回
//
// 路由：POST /api/fs/suggest
//   body: { prefix: "/ho" }
//   resp: { success: true, data: { prefix, base, baseExists, candidates: [...] } }

import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { suggestPath } from '../lib/fs-suggest.js';

export const fsRouter = Router();

fsRouter.post('/suggest', asyncHandler((req, res) => {
  const { prefix } = req.body || {};
  if (typeof prefix !== 'string') {
    return res.status(400).json({ success: false, error: '缺少 prefix（string）' });
  }
  const data = suggestPath(prefix);
  res.json({ success: true, data });
}));
