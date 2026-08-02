import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

/**
 * files.js —— 文件上传 / 下载（artifacts 大文件载体）
 * 挂载于 /api/files。
 * - POST /api/files        上传 {name, content_base64}（≤2MB）→ {file_id, size}
 * - GET  /api/files/:id/download  按原名下载
 * - GET  /api/files/:id/meta      获取元信息（可选）
 * 任务删除不级联删文件（人工管理）。
 */

const MAX_UPLOAD = 2 * 1024 * 1024; // 2MB

export default function (ctx) {
  const { store, auth } = ctx;
  const router = express.Router();

  /** 鉴权：requireUser 或 agent 凭证（双通道） */
  const authAny = (req, res, next) => {
    // agent 凭证通道
    const agentId = req.body?.agent_id || req.query.agent_id;
    const token = req.body?.token || req.query.token;
    if (agentId || token) {
      return auth.requireAgent()(req, res, next);
    }
    return auth.requireUser(req, res, next);
  };

  /** 确保数据目录存在 */
  function filesDir() {
    const dir = path.join(store.dataDir, 'files');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 读取文件元信息索引（内存映射：file_id → {name, size, created_at}） */
  function metaOf(fileId) {
    const metaPath = path.join(filesDir(), `${fileId}.meta.json`);
    if (!fs.existsSync(metaPath)) return null;
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
  }

  function writeMeta(fileId, meta) {
    fs.writeFileSync(path.join(filesDir(), `${fileId}.meta.json`), JSON.stringify(meta));
  }

  // ---- POST /api/files 上传 ----
  router.post('/files', authAny, (req, res) => {
    const { name, content_base64 } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    if (!content_base64 || typeof content_base64 !== 'string') {
      return res.status(400).json({ error: 'content_base64 required' });
    }
    let buf;
    try {
      buf = Buffer.from(content_base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'content_base64 invalid' });
    }
    if (buf.length > MAX_UPLOAD) {
      return res.status(413).json({ error: `文件超过 2MB 限制（${buf.length} bytes）` });
    }
    const fileId = ctx.util.uid('file');
    const safeName = path.basename(name).slice(0, 200); // 防路径穿越
    fs.writeFileSync(path.join(filesDir(), fileId), buf);
    const meta = { file_id: fileId, name: safeName, size: buf.length, created_at: ctx.util.now() };
    writeMeta(fileId, meta);
    store.log('info', 'files', `文件上传 ${fileId}（${safeName}, ${buf.length} bytes）`);
    res.status(201).json(meta);
  });

  // ---- GET /api/files/:id/meta ----
  router.get('/files/:id/meta', authAny, (req, res) => {
    const meta = metaOf(req.params.id);
    if (!meta) return res.status(404).json({ error: 'file not found' });
    res.json(meta);
  });

  // ---- GET /api/files/:id/download ----
  router.get('/files/:id/download', authAny, (req, res) => {
    const fileId = req.params.id;
    const meta = metaOf(fileId);
    if (!meta) return res.status(404).json({ error: 'file not found' });
    const fp = path.join(filesDir(), fileId);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'file content missing' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.name)}"`);
    res.setHeader('Content-Length', String(meta.size));
    fs.createReadStream(fp).pipe(res);
  });

  return router;
}
