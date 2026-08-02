import express from 'express';

/**
 * MCP 仓库。挂载于 /api/mcp-registry。
 * MCP 服务 = 会话驱动型能力包（MCP 接入），与技能仓库（常驻自动型）互补。
 * 提供静态安全审查与 mcp-config 一键生成。
 */

const CATEGORIES = ['filesystem', 'search', 'database', 'devops', 'communication', 'utility'];

/** 内置 MCP 服务定义（首次访问播种）。 */
const BUILTIN_MCPS = [
  {
    name: 'filesystem',
    display_name: '文件系统访问',
    description: '通过 MCP 协议读写本地文件，支持目录浏览、文件搜索、内容编辑。需指定允许访问的根目录。',
    version: '1.0.0',
    category: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{{allowed_dirs}}'],
    env: {},
    url: '',
    headers: {},
    tools: [
      { name: 'read_file', description: '读取指定文件内容' },
      { name: 'write_file', description: '写入文件' },
      { name: 'list_directory', description: '列出目录内容' },
      { name: 'search_files', description: '按名称搜索文件' },
    ],
    config_note: 'allowed_dirs 需替换为允许访问的目录绝对路径，多个用逗号分隔',
  },
  {
    name: 'brave-search',
    display_name: 'Brave 网络搜索',
    description: '通过 Brave Search API 进行网络搜索，返回相关性排序的结果摘要。需要 Brave API Key。',
    version: '1.0.0',
    category: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '{{your_brave_api_key}}' },
    url: '',
    headers: {},
    tools: [
      { name: 'brave_web_search', description: '网络搜索' },
      { name: 'brave_local_search', description: '本地商家搜索' },
    ],
    config_note: '需在 env.BRAVE_API_KEY 填入你的 Brave Search API Key',
  },
  {
    name: 'git',
    display_name: 'Git 版本控制',
    description: '通过 MCP 协议执行 Git 操作：查看状态、diff、log、分支管理。需指定仓库路径。',
    version: '1.0.0',
    category: 'devops',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '{{repo_path}}'],
    env: {},
    url: '',
    headers: {},
    tools: [
      { name: 'git_status', description: '查看工作区状态' },
      { name: 'git_diff', description: '查看差异' },
      { name: 'git_log', description: '查看提交历史' },
      { name: 'git_branch', description: '分支管理' },
    ],
    config_note: 'repo_path 需替换为目标 Git 仓库的绝对路径',
  },
  {
    name: 'sqlite',
    display_name: 'SQLite 数据库',
    description: '通过 MCP 协议查询 SQLite 数据库，支持 SQL 执行与 schema 浏览。需指定数据库文件路径。',
    version: '1.0.0',
    category: 'database',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '{{db_path}}'],
    env: {},
    url: '',
    headers: {},
    tools: [
      { name: 'read_query', description: '执行 SELECT 查询' },
      { name: 'write_query', description: '执行写入 SQL' },
      { name: 'list_tables', description: '列出所有表' },
      { name: 'describe_table', description: '查看表结构' },
    ],
    config_note: 'db_path 需替换为 SQLite 数据库文件的绝对路径',
  },
];

// ---- 静态安全审查规则 ----
const SECRET_PATTERNS = [
  { pattern: /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[=:]\s*['"]?[a-z0-9_\-]{16,}/i, risk: 'high', msg: '检测到疑似硬编码密钥/口令' },
  { pattern: /sk-[a-zA-Z0-9]{20,}/, risk: 'high', msg: '检测到疑似 OpenAI API Key 格式' },
  { pattern: /ghp_[a-zA-Z0-9]{20,}/, risk: 'high', msg: '检测到疑似 GitHub PAT 格式' },
  { pattern: /AKIA[0-9A-Z]{16}/, risk: 'high', msg: '检测到疑似 AWS Access Key 格式' },
];
const DANGER_PATTERNS = [
  { pattern: /\brm\s+-rf?\s+\/(?:\s|$)/, risk: 'high', msg: 'rm -rf / 极度危险' },
  { pattern: /\bsudo\b/i, risk: 'medium', msg: '使用 sudo 提权，需确认必要性' },
  { pattern: /chmod\s+777/, risk: 'medium', msg: 'chmod 777 权限过宽' },
  { pattern: /curl\s+[^|]+\|\s*(sh|bash)/, risk: 'high', msg: 'curl | sh 远程执行，存在供应链风险' },
  { pattern: /\bwget\s+[^|]+\|\s*(sh|bash)/, risk: 'high', msg: 'wget | sh 远程执行，存在供应链风险' },
];
const ENV_DANGER = ['PATH', 'HOME', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'NODE_PATH'];

/** 对 MCP 服务配置执行静态安全审查，返回 {status, notes}。 */
function staticReview(svc) {
  const notes = [];
  const scanText = (label, text) => {
    if (!text) return;
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    for (const r of SECRET_PATTERNS) {
      if (r.pattern.test(str)) notes.push({ risk: r.risk, msg: `${label}: ${r.msg}` });
    }
    for (const r of DANGER_PATTERNS) {
      if (r.pattern.test(str)) notes.push({ risk: r.risk, msg: `${label}: ${r.msg}` });
    }
  };

  scanText('command', svc.command);
  scanText('args', (svc.args || []).join(' '));
  if (svc.env && typeof svc.env === 'object') {
    for (const [k, v] of Object.entries(svc.env)) {
      if (ENV_DANGER.includes(k)) {
        notes.push({ risk: 'medium', msg: `env.${k} 覆盖系统路径变量，可能影响安全` });
      }
      scanText(`env.${k}`, v);
    }
  }
  if (svc.url) {
    if (svc.url.startsWith('http://') && !svc.url.includes('localhost') && !svc.url.includes('127.0.0.1')) {
      notes.push({ risk: 'medium', msg: 'url 使用非加密 HTTP，建议改用 HTTPS' });
    }
    if ((svc.transport === 'http' || svc.transport === 'sse') && (!svc.headers || !svc.headers.Authorization)) {
      notes.push({ risk: 'medium', msg: '远程 MCP 服务未配置 Authorization 头' });
    }
  }

  const hasHigh = notes.some((n) => n.risk === 'high');
  const hasMedium = notes.some((n) => n.risk === 'medium');
  const status = hasHigh ? 'blocked' : hasMedium ? 'warning' : 'passed';
  return { status, notes, reviewed_at: Math.floor(Date.now() / 1000) };
}

/** 首次访问播种内置 MCP 服务。 */
function seedBuiltinMcps(ctx) {
  const coll = ctx.store.coll('mcp_services');
  if (coll.count() > 0) return;
  for (const s of BUILTIN_MCPS) {
    const review = staticReview(s);
    coll.insert({
      id: ctx.util.uid('mcp'),
      ...s,
      security_review: review,
      author: 'ai-bridge',
      builtin: true,
      status: 'active',
      install_count: 0,
      created_at: ctx.util.now(),
      updated_at: ctx.util.now(),
    });
  }
  ctx.store.log('info', 'mcp-registry', `已播种 ${BUILTIN_MCPS.length} 个内置 MCP 服务`);
}

export default function (ctx) {
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;
  const ra = ctx.auth.requireAdmin;
  const mcps = () => store.coll('mcp_services');

  seedBuiltinMcps(ctx);

  // ---- GET /api/mcp-registry（列表，支持 category / transport 过滤）----
  router.get('/', ru, (req, res) => {
    const { category, transport } = req.query;
    let list = mcps().all().sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.created_at - b.created_at;
    });
    if (category) list = list.filter((s) => s.category === category);
    if (transport) list = list.filter((s) => s.transport === transport);
    res.json(list);
  });

  // ---- GET /api/mcp-registry/categories ----
  router.get('/categories', ru, (req, res) => {
    const used = [...new Set(mcps().all().map((s) => s.category))];
    res.json([...new Set([...CATEGORIES, ...used])]);
  });

  // ---- GET /api/mcp-registry/:id ----
  router.get('/:id', ru, (req, res) => {
    const s = mcps().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    res.json(s);
  });

  // ---- GET /api/mcp-registry/:id/config（生成 mcp_config JSON）----
  router.get('/:id/config', ru, (req, res) => {
    const s = mcps().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    let serverCfg;
    if (s.transport === 'stdio') {
      serverCfg = { command: s.command, args: s.args || [], env: s.env || {} };
    } else {
      serverCfg = { url: s.url, headers: s.headers || {} };
    }
    res.json({
      mcpServers: { [s.name]: serverCfg },
      tools: s.tools || [],
      security_review: s.security_review,
      config_note: s.config_note || '',
    });
  });

  // ---- POST /api/mcp-registry（admin：新建）----
  router.post('/', ru, ra, (req, res) => {
    const { name, display_name, description, version, category, transport, command, args, env, url, headers, tools, config_note } = req.body || {};
    if (!name || !display_name || !description || !transport) {
      return res.status(400).json({ error: 'name, display_name, description, transport required' });
    }
    if (!['stdio', 'sse', 'http'].includes(transport)) {
      return res.status(400).json({ error: 'transport must be stdio | sse | http' });
    }
    if (transport === 'stdio' && !command) {
      return res.status(400).json({ error: 'stdio transport requires command' });
    }
    if ((transport === 'sse' || transport === 'http') && !url) {
      return res.status(400).json({ error: 'sse/http transport requires url' });
    }
    if (mcps().all().some((s) => s.name === String(name))) {
      return res.status(409).json({ error: 'mcp name already exists' });
    }
    const draft = {
      name: String(name).slice(0, 60),
      display_name: String(display_name).slice(0, 100),
      description: String(description),
      version: String(version || '1.0.0'),
      category: CATEGORIES.includes(category) ? category : 'utility',
      transport,
      command: String(command || ''),
      args: Array.isArray(args) ? args.map(String) : [],
      env: env && typeof env === 'object' ? env : {},
      url: String(url || ''),
      headers: headers && typeof headers === 'object' ? headers : {},
      tools: Array.isArray(tools) ? tools : [],
      config_note: String(config_note || ''),
    };
    const review = staticReview(draft);
    const s = mcps().insert({
      id: util.uid('mcp'),
      ...draft,
      security_review: review,
      author: req.user.username,
      builtin: false,
      status: 'active',
      install_count: 0,
      created_at: util.now(),
      updated_at: util.now(),
    });
    store.log('info', 'mcp-registry', `新建 MCP 服务：${s.name} (${s.id})，安全审查=${review.status}`);
    res.status(201).json(s);
  });

  // ---- PATCH /api/mcp-registry/:id（admin：编辑；修改配置后自动重审）----
  router.patch('/:id', ru, ra, (req, res) => {
    const s = mcps().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    for (const k of ['display_name', 'description', 'version', 'category', 'transport', 'command', 'url', 'config_note']) {
      if (req.body?.[k] !== undefined) patch[k] = String(req.body[k]);
    }
    if (req.body?.args !== undefined) patch.args = Array.isArray(req.body.args) ? req.body.args.map(String) : [];
    if (req.body?.env !== undefined && typeof req.body.env === 'object') patch.env = req.body.env;
    if (req.body?.headers !== undefined && typeof req.body.headers === 'object') patch.headers = req.body.headers;
    if (req.body?.tools !== undefined) patch.tools = Array.isArray(req.body.tools) ? req.body.tools : [];
    if (req.body?.status !== undefined && ['active', 'disabled'].includes(req.body.status)) patch.status = req.body.status;

    // 配置相关字段变更后重新审查
    const configKeys = ['command', 'args', 'env', 'url', 'headers', 'transport'];
    if (configKeys.some((k) => k in patch)) {
      patch.security_review = staticReview({ ...s, ...patch });
    }
    patch.updated_at = util.now();
    res.json(mcps().update(s.id, patch));
  });

  // ---- POST /api/mcp-registry/:id/review（admin：手动触发静态审查）----
  router.post('/:id/review', ru, ra, (req, res) => {
    const s = mcps().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const review = staticReview(s);
    const updated = mcps().update(s.id, { security_review: review, updated_at: util.now() });
    store.log('info', 'mcp-registry', `手动审查 MCP 服务 ${s.name}：${review.status}（${review.notes.length} 条提示）`);
    res.json(updated);
  });

  // ---- DELETE /api/mcp-registry/:id（admin：删除；内置禁删）----
  router.delete('/:id', ru, ra, (req, res) => {
    const s = mcps().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (s.builtin) return res.status(403).json({ error: 'builtin mcp service cannot be deleted' });
    mcps().remove(s.id);
    store.log('info', 'mcp-registry', `删除 MCP 服务：${s.name} (${s.id})`);
    res.json({ ok: true });
  });

  return router;
}
