# AI 智能体桥接器 (ai-bridge) v5.0.0

Trae IDE 与微信智能体之间的中间层，提供任务队列管理、**执行依据（evidence）**、Web 管理面板和 Chat 对话功能。

## 🆕 v2.0.0 新特性

- **聊天即任务**：每次对话自动入队为 `type=chat` 任务，统一入口
- **执行依据 (evidence)**：每个任务结果携带 5 类证据（命令/文件/搜索/工具/思路）
- **侧滑抽屉**：点击任务/统计/日志，右滑显示详情，支持深链 `#task/xxx`
- **系统日志 API**：`/api/logs?level=&source=` 实时查看桥接器日志
- **任务重试/删除**：`POST /api/tasks/:id/retry`、`DELETE /api/tasks/:id`
- **URL hash 路由**：`#task/<id>`、`#queue/<status>`、`#logs`

## 功能特性

- **任务队列**：支持手动输入和自动接收任务
- **心跳保活**：`/api/heartbeat` 供 Trae 维持会话
- **长轮询**：Trae 通过 `/api/task/poll` 获取任务
- **Web 面板**：4 个区块，3 个侧滑抽屉，响应式
- **Chat 对话**：统一输入框，每条消息入队
- **WebSocket**：实时推送任务/日志更新
- **执行依据**：完整记录智能体的执行轨迹

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（热启动）
npm run dev

# 生产构建
npm run build
npm start
```

默认端口 `4567`，可通过 `PORT` 环境变量修改。

## API 端点

### 核心端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/heartbeat` | GET | 心跳保活（Trae） |
| `/api/task/poll` | GET | 长轮询获取任务（Trae） |
| `/api/task/complete` | POST | 提交任务结果（含 evidence） |
| `/api/task/:id/status` | GET | 任务状态 |
| `/api/task/:id/result` | GET | 任务结果（含 evidence） |
| `/api/tasks/:id/evidence` | GET | 仅返回 evidence |

### 任务管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/tasks` | GET | 任务列表（支持 `status/type/source/limit`） |
| `/api/tasks` | POST | 创建任务（type=chat 聊天即任务） |
| `/api/tasks/:id` | GET | 任务详情 |
| `/api/tasks/:id` | DELETE | 删除任务 |
| `/api/tasks/:id/retry` | POST | 重新入队失败/已完成任务 |

### 系统

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/logs` | GET | 系统日志（支持 `level/source/limit`） |
| `/api/stats` | GET | 队列统计 |
| `/api/context/:sessionId` | GET | 上下文 |
| `/health` | GET | 健康检查 |
| `/api/chat` | POST | 旧版聊天接口（兼容） |
| `/api/chat/history` | GET | 旧版聊天历史（兼容） |

## 任务结构

```typescript
interface Task {
  id: string;                  // task-{ts}-{counter}
  type: TaskType;              // chat | reply_message | query_info | ...
  priority: 'low' | 'normal' | 'high' | 'urgent';
  source: 'manual' | 'chat' | 'wechat' | 'scheduled' | 'system';
  data: { content: string; from_user?: string; extra?: any };
  status: 'pending' | 'assigned' | 'processing' | 'completed' | 'failed';
  created_at: number;
  started_at?: number;
  completed_at?: number;
  assigned_to?: string;
  result?: TaskResult;
}
```

## Evidence（执行依据）

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

## 面板布局

```
┌────────────────────────────────────┐
│  Header                            │
│  状态 + 队列统计 + 日志按钮          │
├────────────────────────────────────┤
│  1. 输入框（统一 chat/task）         │
│  2. 队列状态 4 卡（点击进抽屉）      │
│  3. 任务列表（点击进详情抽屉）        │
│  4. 最近日志（精简 + 抽屉全量）      │
└────────────────────────────────────┘

抽屉：
  - 任务详情（结论 + evidence + 时间线 + 重试/删除）
  - 队列（按状态过滤的任务列表）
  - 日志（级别/来源过滤 + 实时追加）
```

## 配套 Skill

- [weixin-agent.skill.md](~/.trae-cn/skills/weixin-agent.skill.md) —— Trae 智能体技能

## 版本历史

- **v2.0.0**（2026-07-22）：聊天即任务、evidence 协议、侧滑抽屉、URL hash 路由
- **v1.1.0**：心跳保活、Chat 对话、任务结果轮询
- **v1.0.0**：初始版本，基础任务队列和面板
