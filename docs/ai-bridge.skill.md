# ai-bridge 智能体接入 Skill

本文档指导一个 AI 智能体（Agent）如何接入 ai-bridge 协作中枢：注册、心跳、领取任务、提交结果与证据、错误处理。

- 服务地址：以下记为 `$BASE`（例如 `http://localhost:4567`）。
- 所有接口均为 `application/json`。
- Agent 凭证：`agent_id` + `token`（`agt_` 开头）。**token 仅在注册时明文返回一次，必须本地妥善保存。**

---

## 1. 首次注册（只做一次）

```
POST $BASE/api/agent/register
{
  "name": "你的智能体名称",
  "capabilities": ["shell", "search", "code"],
  "host": "本机标识",
  "skill_version": "1.0.0"
}
```

响应 `201`：

```json
{ "agent_id": "agent-...", "token": "agt_...", "review_status": "pending_review" }
```

### 凭证落盘

把凭证写入当前工作目录的 `.ai-bridge-agent.json`（权限 600，勿提交进版本库）：

```json
{
  "base_url": "http://localhost:4567",
  "agent_id": "agent-...",
  "token": "agt_..."
}
```

此后**所有请求都从该文件读取凭证并携带**（query 或 body 中的 `agent_id` + `token`）。
如果本地文件丢失且无法找回，请管理员在后台执行「token 重置」获取新 token。

### 审核等待

新注册的 agent 处于 `pending_review`。此时除心跳外的接口返回：

```
HTTP 403  { "error": "pending_review" }
```

**遇到 403 pending_review：不要频繁重试，每 60 秒降频重试一次**，直到管理员审核通过（`active`）。
若返回 `rejected` 或 `disabled`，停止任务轮询，仅保留心跳并向用户报告原因。

---

## 2. 心跳（每 5 秒一次）

```
GET $BASE/api/heartbeat?agent_id=...&token=...
→ { "ok": true, "review_status": "active", "server_time": 1730000000 }
```

- **固定每 5 秒一次**。超过 15 秒无心跳会被标记为离开（idle），超过 60 秒标记为离线（offline）。
- 心跳在任何审核状态下都放行；用响应里的 `review_status` 感知自己是否已通过审核。
- 心跳失败（网络错误）按第 5 节的连续失败计数处理。

---

## 3. 长轮询领取任务

```
GET $BASE/api/task/poll?agent_id=...&token=...&timeout=30
→ { "task": { ... } }      或      { "task": null }
```

- `timeout` 上限 30 秒；建议用 30 做长轮询，拿到 `task:null` 立即发起下一轮。
- 领取规则（仅 pending 任务）：优先派给你的（`target_agent`），其次匹配你能力的（`required_capability`），最后是通用任务。
- 领取成功的任务已处于 `processing` 且 `assigned_to` 是你。**只有领取者能汇报该任务**（他人 complete 会 403）。

任务结构：

```json
{
  "id": "task-...",
  "type": "execute_command",
  "priority": "normal",
  "source": "manual",
  "data": {
    "content": "任务内容",
    "from_user": "可选",
    "extra": {
      "context": {
        "summary": "早期对话已压缩：...",
        "recent": [
          { "role": "user", "content": "...", "at": 1234567890 },
          { "role": "agent", "content": "...", "at": 1234567891 }
        ]
      },
      "context_note": "extra.context 是对话历史，按时间顺序排列（role: user|assistant），处理时请结合上文理解当前问题。当 source=chat 时，data.extra.context 由服务端自动构造，包含当前用户输入以及本会话中更早的 agent 回复（仅包含已完成任务的结果）。"
    }
  },
  "parent_task_id": "可选，委派链父任务"
}
```

- `data.content` 是用户当前输入。
- `data.extra.context` 是可选的对话历史，**但 chat 场景下由服务端自动填充**，结构为：
  ```json
  {
    "summary": "已压缩的早期会话摘要（200 字内，保留关键结论与实体）",
    "recent": [
      { "role": "user", "content": "...", "at": 1234567890 },
      { "role": "assistant", "content": "...", "at": 1234567891 }
    ]
  }
  ```
- `summary` 为滚动摘要，随着对话轮数增长自动生成；`recent` 固定为最近 6 条用户输入与 agent 回复的摘要（每条回复最多 500 字，**不含 evidence**）。
- **如果存在，请结合 summary 与 recent 理解当前问题**，尤其是代词（"刚才"/"上一个"/"它"/"这个"）需要参照前文。
- `recent` 中 `role=user` 为用户发送的消息（最后一条通常就是 `data.content` 本身），`role=agent` 为 agent 之前回复的摘要或输出。```json
    {
      "summary": "早期对话已压缩：...",
      "recent": [
        { "role": "user", "content": "...", "at": 1234567890 },
        { "role": "agent", "content": "...", "at": 1234567891 }
      ]
    }
    ```
- 当 `source` 为 `chat` 时，服务端会自动构造 `data.extra.context`；agent 应结合上下文理解当前问题，不需要在回复中重复完整历史，只需直接回答当前问题。
- 服务端只会把已完成的（`status=completed`）任务结果作为 `role=assistant` 加入历史，未完成的 pending 任务不会进入历史，避免上下文被永远不会完成的任务污染。
- 如任务内容涉及超出上下文范围的细节，agent 应优先根据 `data.content` 直接处理，必要时参考 `summary` 中的实体信息。

---

## 4. 汇报结果（evidence 提交规范）

任务做完后：

```
POST $BASE/api/task/complete
{
  "agent_id": "...",
  "token": "...",
  "task_id": "task-...",
  "status": "completed",            // 或 "failed"
  "result": {
    "summary": "一句话说明做了什么、结果是什么",
    "evidence": {
      "executed_commands": ["ls -la", "npm test"],
      "read_files": ["src/index.js", "/etc/hosts"],
      "searches": ["web: ai-bridge 文档"],
      "tool_calls": ["bridge_create_task(...)"],
      "mcp_tool_calls": ["filesystem.read_file(/etc/hosts)", "brave-search.brave_web_search(端口排查)"],
      "thinking": "关键推理过程简述"
    }
  }
}
```

evidence 六个字段**全部可选**，但规范要求：

- `summary` 必填，中文一句话，让调度者不点开详情也知道结果。summary 支持 Markdown（代码块、列表、粗体等），前端会渲染为富文本。
- 失败（`status:"failed"`）时 summary 必须写清失败原因；evidence 中保留已执行过的步骤，便于重试时续作。
- `executed_commands` / `read_files` / `searches` / `tool_calls` / `mcp_tool_calls` 为字符串数组，按执行顺序记录真实发生的动作，**不要编造**。
- `thinking` 只写关键判断，一两句即可，不要粘贴完整思考链。
- `mcp_tool_calls` 记录通过 MCP 协议调用的外部工具，格式建议 `服务名.工具名(参数摘要)`，便于区分本地命令与 MCP 工具调用。
- **知识库检索留痕**：执行专业任务前，应优先调用 `bridge_kb_search`（MCP）或 `GET /api/kb/search` 检索知识库；检索到的相关条目可作为背景知识辅助回答。无论通过 MCP 还是 REST 检索，都应在 `evidence.searches` 中记录检索关键词与命中条目数，例如 `searches: ["端口占用排查 (命中 2 条)"]`。这会让前端在对话气泡中展示「🔍 参考了知识库（N 条）」折叠条，增强可信度。

### 成果（artifacts）提交规范

除 `summary` 文字说明外，agent 可在 `result.artifacts` 数组中提交结构化成果卡片，前端会在对话气泡和任务详情抽屉中渲染为可交互的卡片（展开/复制/下载/阅读）。

**三种卡片类型：**

| type | 必填字段 | 说明 | 限制 |
| --- | --- | --- | --- |
| `code` | `name`, `language`, `content` | 代码片段，前端等宽字体+简单着色+前5行预览+展开+复制+下载 | content ≤ 50KB |
| `markdown` | `name`, `content` | 文档卡片，前端渲染 Markdown 预览+「阅读」开抽屉看全文+下载 .md | content ≤ 50KB |
| `file` | `name`, `file_id` | 大文件引用（先上传再引用），前端显示大小+下载 | file_id 须有效 |

**完整 JSON 示例：**

```json
{
  "summary": "已生成用户认证模块，包含登录接口和 JWT 中间件",
  "evidence": {
    "executed_commands": ["cat package.json", "npm test"],
    "read_files": ["src/auth.js"],
    "thinking": "采用 JWT 无状态方案，适合微服务架构"
  },
  "artifacts": [
    {
      "name": "auth.js",
      "type": "code",
      "language": "javascript",
      "content": "import jwt from 'jsonwebtoken';\n\nexport function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.replace('Bearer ', '');\n  if (!token) return res.status(401).json({ error: 'no token' });\n  try {\n    req.user = jwt.verify(token, process.env.JWT_SECRET);\n    next();\n  } catch {\n    res.status(401).json({ error: 'invalid token' });\n  }\n}"
    },
    {
      "name": "接口文档.md",
      "type": "markdown",
      "content": "## 认证接口\n\n### POST /api/login\n- 请求体：`{username, password}`\n- 响应：`{token}`\n\n### 鉴权\n所有需认证的接口在 Header 中携带 `Authorization: Bearer <token>`"
    },
    {
      "name": "test-report.html",
      "type": "file",
      "file_id": "file-abc123",
      "size": 128000
    }
  ]
}
```

**大文件处理（>50KB）：**

代码或文档超过 50KB 时，先上传文件再以 `type: 'file'` 引用：

```
POST $BASE/api/files
{ "agent_id": "...", "token": "...",
  "name": "大文件.js",
  "content_base64": "<base64 编码内容>" }
→ 201 { "file_id": "file-...", "name": "大文件.js", "size": 80000 }

# 再在 artifacts 中引用
{ "name": "大文件.js", "type": "file", "file_id": "file-...", "size": 80000 }
```

文件上传限制 2MB。任务删除不级联删文件（人工管理）。

**校验规则：** 后端对 artifacts 做宽松校验——非法项（无 content、超 50KB、无 file_id、未知 type）会被剔除并记日志，但不会拒绝整个 complete 请求。

**evidence 是 ai-bridge 的差异化体验：不要只返回 summary。** 前端会在对话气泡下方折叠展示一条「🔍 查看执行过程（X 条命令 / Y 个文件 / …）」的展开条，用户点击即可看到真实执行痕迹。这能显著增强可信度，也方便调试。因此 agent 应尽可能把真实动作写进 `executed_commands` / `read_files` / `searches` / `tool_calls` 中。

### 长任务中间进展（可选）

如果任务需要几十秒甚至更久，agent 应该在执行过程中主动向用户报告进度，避免前端"死等"：

```
POST $BASE/api/task/progress
{
  "agent_id": "...",
  "token": "...",
  "task_id": "task-...",
  "progress": "正在执行 df -h，查看磁盘使用情况..."
}
```

- `progress` 为一句简短中文，说明当前正在做什么。
- 建议每隔 5~10 秒或每个关键步骤上报一次。
- 前端会把 `progress` 展示为临时气泡（"Agent 已接单，执行中…（已用时 12s）\n⏳ 正在执行 df -h"），让用户感知到任务仍在推进。

如需拆解任务，agent 可用凭证直接创建子任务（自动 `source=delegation`）：

```
POST $BASE/api/tasks
{ "agent_id": "...", "token": "...",
  "parent_task_id": "父任务 id（可选）",
  "data": { "content": "子任务内容" },
  "target_agent": "可选", "required_capability": "可选" }
```

---

## 5. 错误处理与离线报告

对心跳、poll、complete 等所有请求分别维护**连续失败计数**：

- 请求成功 → 计数清零。
- 网络错误 / 5xx / 超时 → 计数 +1，1~5 秒退避后重试。
- **连续 3 次失败 → 判定自己离线**：停止任务循环，仅保留低频心跳重试（每 30 秒一次），并在恢复后向用户报告「离线时段」。
- HTTP 401（凭证错误）：立即停止并请求用户检查凭证（可能被重置了 token）。
- HTTP 403 `pending_review`：每 60 秒降频重试（见第 1 节）。
- HTTP 403 `rejected` / `disabled`：停止轮询，报告用户联系管理员。
- complete 返回 403「非领取者」：说明任务已被改派/重试，放弃该任务即可。

---

## 6. 主循环参考

```
loop:
  每 5 秒 → heartbeat
  task = poll(timeout=30)
  if task == null: continue
  执行任务（可做委派拆解）
  complete(task_id, status, result{summary, evidence})
  任何一步出错 → 连续失败计数 +1；满 3 次进入离线态
```

## 7. MCP 接入（替代方式）

如果你的运行环境支持 MCP，也可以不走本 skill 的 REST 流程，直接配置 MCP server：

```json
{
  "mcpServers": {
    "ai-bridge": {
      "url": "http://<host>/mcp",
      "headers": { "Authorization": "Bearer agt_..." }
    }
  }
}
```

MCP 提供 7 个工具：`bridge_register`（无需凭证）、`bridge_heartbeat`、`bridge_poll_task`、`bridge_complete_task`、`bridge_create_task`、`bridge_task_status`、`bridge_kb_search`。语义与上文 REST 接口一致（`bridge_poll_task` 为短轮询，不挂起）。其中 `bridge_kb_search` 用于检索知识库，建议执行专业任务前优先调用。完整 mcp_config 可由管理员在「智能体 → 接入」页签一键生成。
