---
name: ai-bridge
description: AI Bridge 通信媒介 - 当前 AI 作为 /home/kali/ai-bridge 的客户端，心跳保活、长轮询任务、执行任务并提交 evidence
---

# AI Bridge Agent v1（通信媒介 + 执行依据）

本技能定义的是**当前 AI 自身**的角色：AI 作为 `/home/kali/ai-bridge` 项目的客户端，通过 `localhost:4567` 与 bridge 通信，持续监听任务队列，获取任务后执行，并提交带执行依据（evidence）的结果。

`/home/kali/ai-bridge` 是运行中的中间程序（Node.js + Express），默认监听 `http://localhost:4567`。它是 AI 与外部系统（如微信、Web 前端、工作流引擎）之间的通信媒介。AI 不直接感知外部客户端，只通过 bridge 收发任务。任务的实际执行由 AI 根据其通用能力完成。

---

## 1. 角色与定位

- **AI 是 ai-bridge 的客户端**：AI 主动连接 `http://localhost:4567`，通过 bridge 获取任务、回传结果。
- **中间程序路径**：`/home/kali/ai-bridge`
- **中间程序启动方式**：在该目录下执行 `npm run dev`（开发）或 `npm run build && npm start`（生产）。默认端口 `4567`。
- **Bridge 是通信媒介**：AI 不直接对接微信、浏览器或其他端，只与 bridge 交互。
- **触发条件**：当用户引用本 skill、或提到“启动 ai-bridge / 连接 bridge / 监听任务队列”时，AI 立即进入本模式。
- **退出条件**：用户明确说“停止 / 暂停 / 退出”之前，AI 不主动停止。
- **默认服务地址**：`http://localhost:4567`。

---

## 2. 核心通信循环

```
while 用户未喊停:
    1. 每 5 秒发送心跳 GET /api/heartbeat
    2. 同时发起长轮询 GET /api/task/poll?timeout=30
    3. 若心跳提示 has_urgent_task=true，立即缩短轮询获取任务
    4. 获取任务后，解析 content、执行、收集 evidence、提交结果
    5. 提交后立即回到步骤 2（继续轮询）
```

### 2.1 心跳保活
```
GET http://localhost:4567/api/heartbeat
```
- 成功：重置失败计数，记录 `has_urgent_task`。
- 连续 3 次失败：报告“ai-bridge 离线”，之后每 10 秒重试，直到恢复。
- 心跳必须持续进行，即使正在执行任务中。

### 2.2 长轮询获取任务
```
GET http://localhost:4567/api/task/poll?timeout=30
```
- 阻塞等待 ≤ 30 秒。
- `has_task=true`：进入任务执行。
- `has_task=false`：30 秒超时后，再次发起轮询。
- 一次只发起一个轮询请求，不要重复发起。

### 2.3 在交互式会话中循环
- 当前 AI 无法启动真正独立的后台线程。AI 在每次会话中模拟循环：心跳 → 轮询 → 执行 → 提交 → 轮询。
- 若一轮轮询 30 秒超时且没有任务，向用户简要报告状态，然后继续下一轮。
- 若用户需要长期后台运行，可由用户在 `/home/kali/ai-bridge` 目录启动一个独立守护进程；本 skill 的核心行为仍是 AI 自身直接连接 bridge。

---

## 3. 任务处理

### 3.1 解析任务
从 `task.data.content` 读取用户意图，识别任务类型：

- `reply_message`：需要回复一条消息
- `query_info`：查询信息
- `generate_content`：生成内容（文案、代码等）
- `execute_command`：执行命令
- `analyze_data`：分析数据/文件
- `multi_step`：多步骤任务
- `chat`：通用对话

### 3.2 执行任务
AI 使用其通用能力（工具调用、搜索、文件读取、代码生成、命令执行等）完成任务。具体执行方式由 AI 根据任务内容自行决定，不需要在 skill 中限定。

### 3.3 收集 evidence
执行任务过程中，记录所有对外的动作和推理过程：

| 字段 | 类型 | 内容 | 示例 |
|------|------|------|------|
| `executed_commands` | array | 执行的 shell 命令 + 输出摘要 | `[{cmd: "df -h /", output_summary: "148G 总 / 95G 已用 / 68%", at: 1234}]` |
| `read_files` | array | 读取的文件 + 用途 | `[{path: "/etc/hosts", purpose: "检查 DNS 配置", at: 1234}]` |
| `searches` | array | 搜索关键词 + 引擎 | `[{query: "北京天气", engine: "web", at: 1234}]` |
| `tool_calls` | array | 调用的 AI 工具 + 入参/出参摘要 | `[{tool: "RunCommand", args: "df -h /", result_summary: "...", at: 1234}]` |
| `thinking` | string | 推理思路（1-3 句话） | `"用户问磁盘 → 用 df -h / → 提取关键信息"` |

**空数组也要保留字段**，5 个字段缺一不可。`at` 使用当前毫秒时间戳。

---

## 4. 提交结果

```
POST http://localhost:4567/api/task/complete
Content-Type: application/json
```

```json
{
  "task_id": "task-xxx",
  "status": "success",
  "result": {
    "action": "query_info",
    "summary": "一句话结论",
    "details": "可选，详细信息/原始数据"
  },
  "evidence": {
    "executed_commands": [...],
    "read_files": [],
    "searches": [],
    "tool_calls": [...],
    "thinking": "..."
  },
  "context_summary": {
    "session_id": "sess-xxx",
    "active_conversations": [
      {
        "user_id": "manual-input",
        "last_active": 1784726400,
        "topic": "系统信息查询",
        "pending_items": [],
        "memory": ["查询磁盘大小"]
      }
    ],
    "global_state": {
      "current_focus": "...",
      "scheduled_tasks": [],
      "alerts": []
    }
  }
}
```

- `status` 可为 `success` 或 `failed`。
- 提交后立即回到轮询循环。
- 同时向用户简要汇报执行结果。

---

## 5. 完整示例

**从 ai-bridge 获取任务**：
```json
{
  "id": "task-1784726397084-1",
  "type": "query_info",
  "data": {"content": "查询当前磁盘大小", "from_user": "manual-input"}
}
```

**AI 执行后提交**：
```json
{
  "task_id": "task-1784726397084-1",
  "status": "success",
  "result": {
    "action": "query_info",
    "summary": "已查询磁盘容量",
    "details": "/dev/sda1: 148G 总，95G 已用，46G 可用，68% 使用率"
  },
  "evidence": {
    "executed_commands": [
      {"cmd": "df -h /", "output_summary": "Filesystem Size Used Avail Use% /dev/sda1 148G 95G 46G 68%", "at": 1784726400000}
    ],
    "read_files": [],
    "searches": [],
    "tool_calls": [
      {"tool": "RunCommand", "args": "df -h /", "result_summary": "148G 总 / 95G 已用 / 46G 可用 / 68%", "at": 1784726400000}
    ],
    "thinking": "用户查询磁盘大小 → 用 df -h 读取根分区 → 提取总/已用/可用/使用率"
  },
  "context_summary": {
    "session_id": "sess-001",
    "active_conversations": [{
      "user_id": "manual-input",
      "last_active": 1784726400,
      "topic": "系统信息查询",
      "pending_items": [],
      "memory": ["查询磁盘大小"]
    }],
    "global_state": {"current_focus": "", "scheduled_tasks": [], "alerts": []}
  }
}
```

---

## 6. 接口速查表

| 用途 | 方法 | 路径 |
|------|------|------|
| 心跳保活 | GET | `/api/heartbeat` |
| 长轮询 | GET | `/api/task/poll?timeout=30` |
| 提交结果 | POST | `/api/task/complete` |
| 任务详情 | GET | `/api/tasks/:id` |
| 任务依据 | GET | `/api/tasks/:id/evidence` |
| 重试任务 | POST | `/api/tasks/:id/retry` |
| 系统日志 | GET | `/api/logs?level=&source=&limit=` |

---

## 7. 错误处理

| 场景 | 处理 |
|------|------|
| 心跳失败 | 计数 +1，继续；连续 3 次 → 报告“ai-bridge 离线” |
| 轮询失败 | 等待 5 秒后重试 |
| 任务执行失败 | `status="failed"` 提交，evidence 中说明失败原因 |
| ai-bridge 离线 | 每 10 秒重试心跳，恢复后继续循环 |

---

## 8. 注意事项

1. **AI 是 ai-bridge 的客户端**：本 skill 是让 AI 直接连接 ai-bridge，不是生成本地独立脚本。
2. **ai-bridge 是通信媒介**：AI 只与 ai-bridge 通信，不直接对接外部终端。
3. **中间程序路径固定**：`/home/kali/ai-bridge`，启动方式见第 1 节。
4. **evidence 必须完整**：5 个字段缺一不可，空数组也要保留。
5. **thinking 不能为空**：至少一句话说明推理过程。
6. **summary 要简洁**：细节放在 `details`。
7. **心跳不能停**：即使执行任务中也要持续心跳。
8. **长轮询不并发**：一次只发起一个轮询请求。
9. **持续运行**：用户未明确停止前，AI 应循环监听、执行、提交。

---

## 9. 与外部独立程序的关系

若用户明确要求“做一个可长期后台运行的程序”，AI 可以额外在 `/home/kali/ai-bridge` 下提供一个参考实现（如 `scripts/ai-bridge-agent.js`），但**本 skill 的核心行为仍是 AI 自身直接连接 ai-bridge**。提供的程序只是可选补充，不是本 skill 的主要目标。
