import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findOrCreateCategoryByName, createItem } from './kb.js';

/**
 * 知识源（最小 Git 挂载）。挂载于 /api/kb-sources。
 * 仅支持 Git 类型：git clone --depth 1 到 data/repos/{id}/，
 * 30s 超时，50MB 上限，README.md + docs/** 的 md/txt 入库。
 * 主条目（README 对应）自动写 extra.favorite 与 extra.note。
 *
 * 集合 kb_sources：{id, name, type, url, branch?, note, local_path,
 *   category_id, status, item_count, last_sync_at?, error?, created_at}
 */
const CLONE_TIMEOUT_MS = 30_000;
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

/** 递归计算目录大小（字节） */
function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过 .git 目录
      if (entry.name === '.git') continue;
      total += dirSize(full);
    } else {
      try { total += fs.statSync(full).size; } catch { /* ignore */ }
    }
  }
  return total;
}

/** 递归收集 md/txt 文件相对路径（排除 .git） */
function collectDocs(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectDocs(path.join(dir, entry.name), rel));
    } else if (/\.(?:md|txt)$/i.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** 从 URL 推导项目名（末段去 .git） */
function repoName(url) {
  const m = String(url || '').match(/\/([^/]+?)(?:\.git)?(?:\/?|#.*)?$/);
  return m ? m[1] : 'unnamed';
}

/**
 * 执行 git clone --depth 1，返回 Promise<{ok, error?}>。
 * 超时 30s，完成后检查目录大小。
 */
function gitClone(url, dest, branch) {
  return new Promise((resolve) => {
    const args = ['clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push(url, dest);
    const child = execFile('git', args, { timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err) => {
      if (err) return resolve({ ok: false, error: err.message });
      const size = dirSize(dest);
      if (size > MAX_SIZE_BYTES) {
        // 超限清理
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
        return resolve({ ok: false, error: `仓库过大（${(size / 1024 / 1024).toFixed(1)}MB > 50MB 上限）` });
      }
      resolve({ ok: true });
    });
    // 兜底：超时后杀进程
    child.on('error', () => resolve({ ok: false, error: 'git 命令执行失败（请确认 git 已安装）' }));
  });
}

/**
 * 将本地仓库目录的 README.md + docs/ 下的 md/txt 入库为知识条目。
 * 主条目（README）写 extra.favorite=true、extra.note、extra.origin。
 * 返回 { items, mainItem, categoryId }。
 */
function indexRepoToKb(ctx, source) {
  const { store, util } = ctx;
  const repoDir = source.local_path;
  const cat = findOrCreateCategoryByName(ctx, source.name || repoName(source.url));
  const categoryId = cat?.id;

  // 收集要入库的文件：README.md 优先，再收 docs/ 下的 md/txt
  const files = [];
  const readmeCandidates = ['README.md', 'README.MD', 'README', 'readme.md'];
  let readmePath = null;
  for (const name of readmeCandidates) {
    if (fs.existsSync(path.join(repoDir, name))) { readmePath = name; break; }
  }
  if (readmePath) files.push(readmePath);
  // docs/ 目录
  const docsDir = path.join(repoDir, 'docs');
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    for (const rel of collectDocs(docsDir)) files.push(path.join('docs', rel));
  }
  // 兜底：根目录的其他 md/txt（排除 README）
  if (files.length === 0) {
    for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
      if (entry.isFile() && /^(?:md|txt)$/i.test(path.extname(entry.name).slice(1))) files.push(entry.name);
    }
  }

  const items = [];
  let mainItem = null;
  for (const rel of files) {
    const full = path.join(repoDir, rel);
    let content = '';
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (content.length > 100_000) content = content.slice(0, 100_000); // 单文件截断
    const isReadme = readmePath && rel === readmePath;
    const item = createItem(ctx, {
      category_id: categoryId,
      title: isReadme ? source.name : `${source.name} / ${rel}`,
      content,
      tags: isReadme ? ['README', 'Git收藏'] : ['Git收藏'],
      extra: isReadme
        ? { favorite: true, note: source.note || '', origin: { source_id: source.id, path: rel } }
        : { origin: { source_id: source.id, path: rel } },
    });
    items.push(item);
    if (isReadme) mainItem = item;
  }
  // 无 README 时取第一个作为主条目
  if (!mainItem && items.length) {
    mainItem = items[0];
    store.coll('kb').update(mainItem.id, {
      extra: { ...mainItem.extra, favorite: true, note: source.note || '', origin: { source_id: source.id, path: files[0] } },
    });
  }
  return { items, mainItem, categoryId };
}

export default function (ctx) {
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;
  const sources = () => store.coll('kb_sources');
  const REPOS_DIR = path.join(store.dataDir, 'repos');

  // 确保仓库目录存在
  if (!fs.existsSync(REPOS_DIR)) fs.mkdirSync(REPOS_DIR, { recursive: true });

  // ---- GET / 列表（含条目数）----
  router.get('/', ru, (req, res) => {
    const list = sources().all().sort((a, b) => b.created_at - a.created_at);
    // 实时计算条目数（按 origin.source_id 反查 kb items）
    const kbItems = store.coll('kb').all().filter((x) => x.kind === 'item');
    for (const s of list) {
      s.item_count = kbItems.filter((i) => i.extra?.origin?.source_id === s.id).length;
    }
    res.json(list);
  });

  // ---- GET /:id ----
  router.get('/:id', ru, (req, res) => {
    const s = sources().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    // 附该源的条目列表
    const items = store.coll('kb').all()
      .filter((x) => x.kind === 'item' && x.extra?.origin?.source_id === s.id)
      .sort((a, b) => a.created_at - b.created_at);
    res.json({ ...s, items });
  });

  // ---- POST / 挂载 Git 仓库（同步克隆 + 入库）----
  router.post('/', ru, async (req, res) => {
    const { url, note, branch } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url required' });
    }
    // 基本 URL 校验
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
      return res.status(400).json({ error: 'url 必须以 http(s):// 或 git@ 或 ssh:// 开头' });
    }
    const name = repoName(url);
    const id = util.uid('kbsrc');
    const localPath = path.join(REPOS_DIR, id);
    const source = sources().insert({
      id, name, type: 'git', url, branch: branch || undefined,
      note: String(note || ''),
      local_path: localPath,
      status: 'cloning',
      item_count: 0,
      created_at: util.now(),
    });
    store.log('info', 'kb-sources', `开始挂载 Git 仓库：${name} (${url})`);

    // 同步克隆（30s 超时）
    const cloneResult = await gitClone(url, localPath, branch);
    if (!cloneResult.ok) {
      sources().update(id, { status: 'failed', error: cloneResult.error, last_sync_at: util.now() });
      store.log('error', 'kb-sources', `挂载失败 ${name}：${cloneResult.error}`);
      return res.status(400).json({ error: cloneResult.error, source });
    }

    // 入库
    try {
      const { items, mainItem, categoryId } = indexRepoToKb(ctx, { ...source, local_path: localPath });
      sources().update(id, {
        status: 'synced',
        item_count: items.length,
        last_sync_at: util.now(),
        error: undefined,
      });
      store.log('info', 'kb-sources', `挂载成功 ${name}：入库 ${items.length} 条`);
      res.status(201).json({ ...sources().get(id), main_item_id: mainItem?.id, category_id: categoryId });
    } catch (e) {
      sources().update(id, { status: 'failed', error: e.message, last_sync_at: util.now() });
      res.status(500).json({ error: e.message });
    }
  });

  // ---- POST /:id/sync 重新同步（git pull + 重新索引）----
  router.post('/:id/sync', ru, async (req, res) => {
    const s = sources().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (!fs.existsSync(s.local_path)) {
      return res.status(400).json({ error: '本地目录不存在，请重新挂载' });
    }
    // git pull（浅克隆用 fetch + reset）
    await new Promise((resolve) => {
      execFile('git', ['-C', s.local_path, 'fetch', '--depth', '1', 'origin'], { timeout: CLONE_TIMEOUT_MS }, () => {
        execFile('git', ['-C', s.local_path, 'reset', '--hard', 'FETCH_HEAD'], { timeout: 10_000 }, () => resolve());
      });
    });
    // 先删除该源旧条目
    const kb = store.coll('kb');
    const oldItems = kb.all().filter((x) => x.kind === 'item' && x.extra?.origin?.source_id === s.id);
    for (const item of oldItems) {
      for (const c of store.coll('kb_chunks').all()) if (c.item_id === item.id) store.coll('kb_chunks').remove(c.id);
      kb.remove(item.id);
    }
    // 重新索引
    const { items, mainItem } = indexRepoToKb(ctx, s);
    sources().update(s.id, { status: 'synced', item_count: items.length, last_sync_at: util.now(), error: undefined });
    store.log('info', 'kb-sources', `同步成功 ${s.name}：入库 ${items.length} 条`);
    res.json({ ...sources().get(s.id), main_item_id: mainItem?.id });
  });

  // ---- DELETE /:id（删除源 + 其条目，保留本地仓库可选）----
  router.delete('/:id', ru, (req, res) => {
    const s = sources().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    // 删除关联条目
    const kb = store.coll('kb');
    const items = kb.all().filter((x) => x.kind === 'item' && x.extra?.origin?.source_id === s.id);
    for (const item of items) {
      for (const c of store.coll('kb_chunks').all()) if (c.item_id === item.id) store.coll('kb_chunks').remove(c.id);
      kb.remove(item.id);
    }
    // 删除本地仓库目录
    try { fs.rmSync(s.local_path, { recursive: true, force: true }); } catch { /* ignore */ }
    sources().remove(s.id);
    store.log('info', 'kb-sources', `已删除知识源 ${s.name}（含 ${items.length} 条目）`);
    res.json({ ok: true, removed_items: items.length });
  });

  return router;
}
