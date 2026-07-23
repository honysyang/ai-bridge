# AI 智能体桥接器 (ai-bridge) v5.1.0

[![Version](https://img.shields.io/badge/version-5.1.0-blue.svg)](https://gitee.com/yzj1/ai-bridge/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

> Trae IDE / 微信 ClawBot 与 AI 智能体之间的**通用中间层**：任务队列 + 执行依据 (evidence) + Web 工作台 + 微信适配 + 知识图谱 + 一键周报。

---

## 📸 界面预览

7 个核心界面截图（1440×900，headless Chromium 截取）：

| 截图 | 模块 | 说明 |
|------|------|------|
| ![chat](docs/screenshots/chat.png) | 💬 聊天 | 三栏工作台：会话 / 任务流 / 详情 |
| ![kb](docs/screenshots/kb.png) | 📖 知识库 | 7 个分类、26+ 条目，支持搜索/筛选 |
| ![graph](docs/screenshots/kb-graph.png) | 🕸 知识图谱 | Cytoscape 可视化，22 条关联 |
| ![workflow](docs/screenshots/workflow.png) | ⚙️ 工作流 | 多步任务模板（3 步示例：查茅台股价 → 查飞天茅台酒价） |
| ![plan](docs/screenshots/plan.png) | 📅 计划 | 周计划 / 日计划，状态跟踪 |
| ![report](docs/screenshots/report.png) | 📝 周报 | 一键汇总本周数据为 Markdown |
| ![claw](docs/screenshots/claw.png) | 💬 微信 Claw | iLink Bot 已登录状态、二维码扫码入口 |

> 💡 截图规范：浏览器 1440×900，headless Chromium 截取，演示数据已加载。

---

## ✨ 核心特性

### v5.1.0（当前）
- **📅 计划模块**：周计划 / 日计划、状态机、优先级、演示数据
- **📝 一键周报**：聚合本周计划 + 完成任务 + 知识库新增，输出 Markdown，支持复制 / 下载
- **⚙️ 多状态过滤**：「处理中」tab 同时匹配 assigned + processing 状态

### v5.0.0
- **🕸 知识图谱**：Cytoscape.js 可视化，节点按分类着色、cose 布局、拖拽缩放
- **📖 知识库 2.0**：分类树 + 条目卡片 + 详情抽屉，支持关联（links）
- **⚙️ 工作流**：多步任务模板，步骤依赖、批量任务创建
- **💬 微信 Claw 适配层**：扫码登录、消息收发、1:1 请求-应答、会话级总结
- **🖥 多面板工作台**：顶部 tab 菜单切换 4 个主面板（聊天/知识库/工作流/计划）

### 历史
- **v4.x**：聊天即任务、evidence 执行依据协议、侧滑抽屉
- **v3.x**：三栏工作台、JSONL 持久化
- **v2.x**：心跳保活 + 长轮询、URL hash 路由
- **v1.x**：基础任务队列

---

## 🚀 快速开始

```bash
# 克隆
git clone https://gitee.com/yzj1/ai-bridge.git
cd ai-bridge

# 安装依赖
npm install

# 开发模式（热启动，自动清理端口冲突）
npm run dev

# 生产构建
npm run build
npm start

# 烟囱测试（15 个端点全量检查）
npm run smoke
```

默认端口 `4567`，可通过 `PORT` 环境变量修改。

启动后访问：http://localhost:4567

---

## 🏗 架构

```
┌─────────────────────────────────────────────────────────┐
│  Web 工作台（端口 4567）                                 │
│  ├─ 💬 聊天      三栏：会话 / 任务 / 详情                │
│  ├─ 📖 知识库    分类树 / 列表 / 图谱                    │
│  ├─ ⚙️ 工作流    模板 / 步骤 / 执行                     │
│  └─ 📅 计划      周 / 日 / 状态 / 周报                  │
└────────────────┬────────────────────────────────────────┘
                 │ REST + WebSocket
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Bridge 后端（Node.js + Express）                        │
│  ├─ 任务队列（JSONL 持久化）                             │
│  ├─ 会话管理（CRUD + 默认会话保护）                      │
│  ├─ 知识库 store（分类 / 条目 / 关联）                   │
│  ├─ 工作流 store（模板 / 执行）                          │
│  └─ Claw 适配层（微信 iLink SDK）                       │
└────────────────┬────────────────────────────────────────┘
                 │ HTTP + 长轮询
                 ▼
┌─────────────────────────────────────────────────────────┐
│  外部智能体                                              │
│  ├─ Trae Agent（通过 weixin-agent skill）                │
│  └─ 微信 ClawBot（扫码登录 / 消息收发）                  │
└─────────────────────────────────────────────────────────┘
```

---

## 📂 目录结构

```
ai-bridge/
├── src/
│   ├── index.ts                # 入口
│   ├── server.ts               # Express 装配 + 中间件
│   ├── task-queue.ts           # 任务状态机 + CRUD
│   ├── session.ts              # 会话管理
│   ├── storage.ts              # JSONL 持久化（任务/会话/日志）
│   ├── kb-store.ts             # 知识库 store
│   ├── kb-link-store.ts        # 知识图谱关联
│   ├── workflow-store.ts       # 工作流 store
│   ├── types.ts                # 全局类型定义
│   ├── middleware/             # error / notFound
│   ├── routes/                 # 路由模块
│   │   ├── health.ts
│   │   ├── heartbeat.ts
│   │   ├── sessions.ts
│   │   ├── tasks.ts
│   │   ├── kb.ts
│   │   ├── workflows.ts
│   │   ├── chat.ts
│   │   └── claw.ts             # 微信 Claw 路由
│   └── claw/                   # Claw 适配
│       ├── manager.ts          # 适配器管理
│       ├── message-bridge.ts   # 消息桥接（请求-应答 1:1）
│       └── ilink-adapter.ts    # iLink SDK 封装
├── public/                     # 静态资源
│   ├── index.html
│   ├── app.js                  # 前端 SPA（~3000 行）
│   └── style.css
├── scripts/
│   ├── predev.sh               # 端口冲突清理
│   └── smoke.sh                # 端到端烟囱测试
├── data/                       # JSONL 持久化（gitignore）
│   ├── tasks.jsonl
│   ├── sessions.jsonl
│   └── logs.jsonl
└── docs/                       # 文档 + 截图
    └── screenshots/
```

---

## 📡 API 端点

> 完整端点列表：38+ 个，按模块分组。

### 核心（Trae 智能体使用）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/heartbeat` | GET | 心跳保活（每 5 秒） |
| `/api/task/poll?timeout=30` | GET | 长轮询获取任务（≤ 30 秒） |
| `/api/task/complete` | POST | 提交任务结果（含 evidence） |
| `/api/task/:id/status` | GET | 任务状态 |
| `/api/task/:id/result` | GET | 任务结果（含 evidence） |
| `/api/tasks/:id/evidence` | GET | 仅返回 evidence |
| `/api/tasks/:id/retry` | POST | 重新入队失败/已完成任务 |

### 任务管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/tasks` | GET | 任务列表（支持 `status/type/source/since/limit`） |
| `/api/tasks` | POST | 创建任务（type=chat 聊天即任务） |
| `/api/tasks/:id` | GET | 任务详情 |
| `/api/tasks/:id` | DELETE | 删除任务 |
| `/api/tasks/stats` | GET | 队列统计 |

### 会话管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sessions` | GET | 会话列表（支持 `status/q`） |
| `/api/sessions` | POST | 创建会话 |
| `/api/sessions/:id` | PATCH | 重命名/归档 |
| `/api/sessions/:id` | DELETE | 删除（任务转默认会话） |

### 知识库

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/kb` | GET | 列出全部（categories + items + links） |
| `/api/kb/seed-demo` | POST | 追加演示数据 |
| `/api/kb/categories` | POST | 创建分类 |
| `/api/kb/categories/:id` | PATCH | 更新分类 |
| `/api/kb/categories/:id` | DELETE | 删除分类 |
| `/api/kb/items` | POST | 创建条目 |
| `/api/kb/items/:id` | PATCH | 更新条目 |
| `/api/kb/items/:id` | DELETE | 删除条目（级联） |
| `/api/kb/links` | GET | 列出关联（可按 item_id 过滤） |
| `/api/kb/links` | POST | 创建关联 |
| `/api/kb/links/:id` | DELETE | 删除关联 |

### 工作流

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/workflows` | GET | 列出所有工作流 |
| `/api/workflows` | POST | 创建工作流 |
| `/api/workflows/:id` | PATCH | 更新工作流 |
| `/api/workflows/:id` | DELETE | 删除工作流 |
| `/api/workflows/:id/execute` | POST | 执行工作流（批量创建任务） |

### 微信 Claw

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/claw/status` | GET | 微信连接状态 |
| `/api/claw/login/start` | POST | 启动扫码登录 |
| `/api/claw/logout` | POST | 退出登录 |
| `/api/claw/restart` | POST | 重启适配器 |
| `/api/claw/contacts` | GET | 联系人列表 |
| `/api/claw/rooms` | GET | 群聊列表 |
| `/api/claw/qrcode.png` | GET | 登录二维码 |
| `/api/claw/send` | POST | 主动发送文本（{wxid, content}） |
| `/api/claw/config` | GET / PATCH | 配置 |
| `/api/claw/ilink/credentials` | GET | 凭证信息 |

### 系统

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/logs` | GET | 系统日志（level/source/limit） |
| `/api/context/:sessionId` | GET | 上下文 |

---

## 📊 数据结构

### Task

```typescript
interface Task {
  id: string;                  // task-{ts}-{counter}
  type: TaskType;              // chat | reply_message | query_info | analyze_data | generate_content | execute_command | multi_step
  priority: 'low' | 'normal' | 'high' | 'urgent';
  source: 'manual' | 'chat' | 'wechat' | 'scheduled' | 'system' | 'workflow';
  data: { content: string; from_user?: string; extra?: any };
  status: 'pending' | 'assigned' | 'processing' | 'completed' | 'failed';
  created_at: number;
  started_at?: number;
  completed_at?: number;
  assigned_to?: string;
  session_id?: string;
  result?: TaskResult;
}
```

### Evidence（执行依据）

每个 `TaskResult` 可携带 `evidence` 字段：

```json
{
  "executed_commands": [
    { "cmd": "df -h /", "output_summary": "Filesystem ... 148G 95G 46G 68%", "at": 1234567890 }
  ],
  "read_files": [
    { "path": "/etc/hosts", "purpose": "检查 DNS 配置", "at": 1234567890 }
  ],
  "searches": [
    { "query": "北京天气", "engine": "web", "at": 1234567890 }
  ],
  "tool_calls": [
    { "tool": "web_search", "args": { "q": "..." }, "result_summary": "...", "at": 1234567890 }
  ],
  "thinking": "用户问天气 → 用 wttr.in → 解析 JSON → 输出中文"
}
```

---

## 🤖 配套 Skill

- [weixin-agent.skill.md](https://gitee.com/yzj1/ai-bridge/blob/main/docs/weixin-agent.skill.md) —— Trae 智能体技能
  - 心跳保活（每 5 秒）
  - 长轮询获取任务（≤ 30 秒）
  - 提交结果（含 evidence）
  - 错误处理（3 次失败报告离线）

---

## 🛠 配套脚本

```bash
# 端口冲突自动清理
bash scripts/predev.sh 4567

# 端到端烟囱测试（15 个端点）
npm run smoke

# 类型检查
npm run typecheck
```

---

## 🐛 常见问题

### 端口被占用
```bash
bash scripts/predev.sh 4567
# 或手动
lsof -ti:4567 | xargs -r kill -9
```

### 微信无法连接
- 检查 `/api/claw/status`
- 重新扫码：`POST /api/claw/login/start` → 打开 `/api/claw/qrcode.png`
- iLink 凭证：`GET /api/claw/ilink/credentials`

### 数据迁移
所有数据存于 `data/*.jsonl`，是 append-only 事件流。备份即 `cp data/`。

---

## 📝 版本历史

- **v5.1.0**（2026-07-23）：计划模块、一键周报、多状态过滤、知识图谱稳定化
- **v5.0.0**（2026-07-22）：多面板工作台、知识库 2.0、工作流、微信 Claw 适配层
- **v4.0.0**（2026-07-21）：聊天即任务、evidence 协议、侧滑抽屉
- **v3.0.0**（2026-07-20）：三栏工作台、JSONL 持久化
- **v2.0.0**：心跳保活 + 长轮询、URL hash 路由
- **v1.0.0**：初始版本，基础任务队列

---

## 🤝 贡献

欢迎 PR / Issue！

- 仓库：https://gitee.com/yzj1/ai-bridge
- 反馈：在 Gitee Issues 中提交

---

## 📄 License

[MIT](./LICENSE)
