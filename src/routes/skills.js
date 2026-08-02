import express from 'express';

/**
 * 技能仓库。挂载于 /api/skills。
 * 技能 = 常驻自动型能力包（Skill 接入），与 MCP 仓库（会话驱动型）互补。
 * 内置技能在首次访问时播种；管理员可新增/编辑/删除自定义技能。
 */
const CATEGORIES = ['system', 'devops', 'research', 'writing', 'security', 'integration'];

/** 内置技能定义（首次访问时播种，已存在则跳过）。 */
const BUILTIN_SKILLS = [
  {
    name: 'shell-executor',
    display_name: 'Shell 命令执行器',
    description: '在目标主机执行 shell 命令并返回标准输出/错误，支持超时与工作目录设置。适用于运维操作、环境检查、脚本执行等场景。',
    version: '1.0.0',
    category: 'system',
    capabilities: ['shell'],
    skill_doc: `# Shell 命令执行器技能

## 能力声明
\`\`\`json
{ "capabilities": ["shell"] }
\`\`\`

## 工作方式
Agent 注册时声明 \`shell\` 能力，ai-bridge 会将 \`required_capability: "shell"\` 的任务优先派发给本技能 agent。

## 接入步骤
1. 注册 agent：\`POST /api/agent/register\` body 含 \`"capabilities":["shell"]\`
2. 等待管理员审核通过
3. 每 5s 心跳 + 长轮询领取 \`type: "execute_command"\` 任务
4. 执行命令后将 stdout/stderr 写入 \`result.summary\`，命令记录到 \`evidence.executed_commands\`

## 安全建议
- 仅执行任务 data.content 中明确的命令，不要自行扩展
- 涉及删除/修改的命令在 evidence.thinking 中说明理由`,
    config_example: { capabilities: ['shell'], poll_timeout: 30 },
  },
  {
    name: 'web-searcher',
    display_name: '网络搜索助手',
    description: '通过搜索引擎检索网络信息并返回摘要。适用于资料调研、问题排查、竞品分析等需要外部知识的场景。',
    version: '1.0.0',
    category: 'research',
    capabilities: ['search'],
    skill_doc: `# 网络搜索助手技能

## 能力声明
\`\`\`json
{ "capabilities": ["search"] }
\`\`\`

## 工作方式
声明 \`search\` 能力后，ai-bridge 会将 \`required_capability: "search"\` 的任务派发给本技能 agent。

## 接入步骤
1. 注册 agent 时声明 \`"capabilities":["search"]\`
2. 审核通过后长轮询领取任务
3. 执行搜索，将关键结果摘要写入 summary
4. 在 evidence.searches 中记录查询关键词，如 \`"web: ai-bridge 架构 (命中 5 条)"\`

## 建议配合知识库
执行任务前先调用 bridge_kb_search 检索本地知识库，再补充网络搜索结果。`,
    config_example: { capabilities: ['search'], max_results: 10 },
  },
  {
    name: 'code-reviewer',
    display_name: '代码审查员',
    description: '读取代码文件并按规范审查，输出问题清单与改进建议。支持多语言、关注安全漏洞与最佳实践。',
    version: '1.0.0',
    category: 'system',
    capabilities: ['code', 'search'],
    skill_doc: `# 代码审查员技能

## 能力声明
\`\`\`json
{ "capabilities": ["code", "search"] }
\`\`\`

## 工作方式
声明 \`code\` 能力后，领取代码审查类任务。读取指定文件，输出结构化审查报告。

## 接入步骤
1. 注册 agent 时声明 \`"capabilities":["code","search"]\`
2. 领取任务后读取 data.content 指定的文件路径
3. 将审查结果写入 summary（Markdown 格式）
4. evidence.read_files 记录读取的文件，evidence.thinking 记录审查重点

## 审查维度建议
- 安全：注入、硬编码凭证、不安全反序列化
- 性能：N+1 查询、不必要的同步操作
- 可维护性：命名、复杂度、重复代码`,
    config_example: { capabilities: ['code', 'search'] },
  },
  {
    name: 'port-scanner',
    display_name: '端口扫描器',
    description: '对目标主机进行端口探测与服务识别，输出开放端口清单。适用于安全巡检与资产盘点。',
    version: '1.0.0',
    category: 'security',
    capabilities: ['scan', 'shell'],
    skill_doc: `# 端口扫描器技能

## 能力声明
\`\`\`json
{ "capabilities": ["scan", "shell"] }
\`\`\`

## 工作方式
声明 \`scan\` 能力后，领取端口扫描类任务。AI 智能路由会将含"扫描/端口"关键词的任务路由到本 agent。

## 接入步骤
1. 注册 agent 时声明 \`"capabilities":["scan","shell"]\`
2. 领取任务后执行扫描命令（如 nmap、masscan）
3. 将开放端口清单写入 summary
4. evidence.executed_commands 记录实际执行的扫描命令

## 安全约束
- 仅扫描授权范围内的目标
- 扫描结果含敏感信息时，summary 中脱敏处理`,
    config_example: { capabilities: ['scan', 'shell'], timeout: 120 },
  },
  {
    name: 'doc-writer',
    display_name: '文档撰写员',
    description: '根据需求生成技术文档、API 说明、周报等结构化文本。支持 Markdown 格式与模板复用。',
    version: '1.0.0',
    category: 'writing',
    capabilities: ['writing'],
    skill_doc: `# 文档撰写员技能

## 能力声明
\`\`\`json
{ "capabilities": ["writing"] }
\`\`\`

## 工作方式
声明 \`writing\` 能力后，领取文档生成类任务。输出 Markdown 格式的结构化文档。

## 接入步骤
1. 注册 agent 时声明 \`"capabilities":["writing"]\`
2. 领取任务后根据 data.content 的需求生成文档
3. summary 为完整文档内容（Markdown）
4. 可配合提示词库（/api/prompts）使用模板

## 输出规范
- 使用 ## 作为主标题层级
- 代码块标注语言
- 表格用于结构化对比`,
    config_example: { capabilities: ['writing'] },
  },
  {
    name: 'kb-curator',
    display_name: '知识库维护员',
    description: '自动整理任务经验回流知识库，执行知识检索、条目归类、关联建议。提升团队知识沉淀效率。',
    version: '1.0.0',
    category: 'system',
    capabilities: ['kb', 'search'],
    skill_doc: `# 知识库维护员技能

## 能力声明
\`\`\`json
{ "capabilities": ["kb", "search"] }
\`\`\`

## 工作方式
声明 \`kb\` 能力后，领取知识库维护类任务。可调用 bridge_kb_search 检索、POST /api/kb/from-task 回流经验。

## 接入步骤
1. 注册 agent 时声明 \`"capabilities":["kb","search"]\`
2. 执行任务前优先调用 bridge_kb_search 检索相关知识
3. 任务完成后将有价值经验通过 /api/kb/from-task 回流
4. evidence.searches 记录知识库检索关键词与命中数

## 经验回流规范
- 仅回流可复用的通用经验，不含一次性临时信息
- 标题用问题概述，内容含"问题/解决方案/执行要点"三段`,
    config_example: { capabilities: ['kb', 'search'] },
  },
];

/** 首次访问播种内置技能（已存在同名则跳过）。 */
function seedBuiltinSkills(ctx) {
  const coll = ctx.store.coll('skills');
  if (coll.count() > 0) return;
  for (const s of BUILTIN_SKILLS) {
    coll.insert({
      id: ctx.util.uid('skill'),
      ...s,
      author: 'ai-bridge',
      builtin: true,
      status: 'active',
      install_count: 0,
      created_at: ctx.util.now(),
      updated_at: ctx.util.now(),
    });
  }
  ctx.store.log('info', 'skills', `已播种 ${BUILTIN_SKILLS.length} 个内置技能`);
}

export default function (ctx) {
  const router = express.Router();
  const { store, util } = ctx;
  const ru = ctx.auth.requireUser;
  const ra = ctx.auth.requireAdmin;
  const skills = () => store.coll('skills');

  // 首次访问播种
  seedBuiltinSkills(ctx);

  // ---- GET /api/skills（列表，支持 category 过滤）----
  router.get('/', ru, (req, res) => {
    const cat = req.query.category;
    let list = skills().all().sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.created_at - b.created_at;
    });
    if (cat) list = list.filter((s) => s.category === cat);
    res.json(list);
  });

  // ---- GET /api/skills/categories（分类列表）----
  router.get('/categories', ru, (req, res) => {
    const used = [...new Set(skills().all().map((s) => s.category))];
    const all = [...new Set([...CATEGORIES, ...used])];
    res.json(all);
  });

  // ---- GET /api/skills/:id（详情）----
  router.get('/:id', ru, (req, res) => {
    const s = skills().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    res.json(s);
  });

  // ---- GET /api/skills/:id/doc（仅返回技能接入文档 markdown）----
  router.get('/:id/doc', ru, (req, res) => {
    const s = skills().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    res.json({ name: s.name, display_name: s.display_name, skill_doc: s.skill_doc || '', config_example: s.config_example || {} });
  });

  // ---- POST /api/skills（admin：新建自定义技能）----
  router.post('/', ru, ra, (req, res) => {
    const { name, display_name, description, version, category, capabilities, skill_doc, config_example } = req.body || {};
    if (!name || !display_name || !description) {
      return res.status(400).json({ error: 'name, display_name, description required' });
    }
    // name 唯一性校验
    if (skills().all().some((s) => s.name === String(name))) {
      return res.status(409).json({ error: 'skill name already exists' });
    }
    const s = skills().insert({
      id: util.uid('skill'),
      name: String(name).slice(0, 60),
      display_name: String(display_name).slice(0, 100),
      description: String(description),
      version: String(version || '1.0.0'),
      category: CATEGORIES.includes(category) ? category : 'system',
      capabilities: Array.isArray(capabilities) ? capabilities.map(String) : [],
      skill_doc: String(skill_doc || ''),
      config_example: config_example || {},
      author: req.user.username,
      builtin: false,
      status: 'active',
      install_count: 0,
      created_at: util.now(),
      updated_at: util.now(),
    });
    store.log('info', 'skills', `新建技能：${s.name} (${s.id})`);
    res.status(201).json(s);
  });

  // ---- PATCH /api/skills/:id（admin：编辑）----
  router.patch('/:id', ru, ra, (req, res) => {
    const s = skills().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    for (const k of ['display_name', 'description', 'version', 'category', 'skill_doc']) {
      if (req.body?.[k] !== undefined) patch[k] = String(req.body[k]);
    }
    if (req.body?.capabilities !== undefined) {
      patch.capabilities = Array.isArray(req.body.capabilities) ? req.body.capabilities.map(String) : [];
    }
    if (req.body?.config_example !== undefined && typeof req.body.config_example === 'object') {
      patch.config_example = req.body.config_example;
    }
    if (req.body?.status !== undefined && ['active', 'disabled'].includes(req.body.status)) {
      patch.status = req.body.status;
    }
    patch.updated_at = util.now();
    res.json(skills().update(s.id, patch));
  });

  // ---- DELETE /api/skills/:id（admin：删除；内置技能禁删）----
  router.delete('/:id', ru, ra, (req, res) => {
    const s = skills().get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (s.builtin) return res.status(403).json({ error: 'builtin skill cannot be deleted' });
    skills().remove(s.id);
    store.log('info', 'skills', `删除技能：${s.name} (${s.id})`);
    res.json({ ok: true });
  });

  return router;
}
