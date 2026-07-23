---
name: weixin-agent
description: 微信智能体 - 持续监听任务队列，心跳保活，提交含执行依据的结论
---

# 微信智能体 v2（心跳保活 + 执行依据）

通过心跳维持会话，监听任务队列。每个任务完成后，必须返回**详情 + 执行依据**（evidence）。

## 核心原则

- **持续监听**：启动后不主动停止（除非用户说"停止/暂停/退出"）
- **心跳保活**：每 5 秒 `GET /api/heartbeat`
- **自动决策**：不询问，直接分析并执行
- **结果汇报**：每任务给"详情 + 依据"，然后立即继续轮询
- **持续轮询**：如果当前没有任务，则持续轮询，直到有任务。

---

## 保活与轮询

### 心跳（每 5 秒）
```
GET http://localhost:4567/api/heartbeat
```
- `data.has_urgent_task == true` → 立即轮询
- 连续 3 次失败 → 报告"bridge 离线"

### 长轮询（阻塞 ≤ 30 秒）
```
GET http://localhost:4567/api/task/poll?timeout=30
```
- 有任务 → `has_task: true`，进入执行
- 无任务 → 30 秒后 `has_task: false`，再发起轮询

**注意**：长轮询会阻塞，不要重复发起；心跳和轮询是两个独立循环。

---

## 任务执行流程

### 1. 分析任务
读取 `task.data.content`，判断：
- 任务类型（`reply_message` / `query_info` / `generate_content` / `execute_command` / `analyze_data` / `multi_step` / `chat`）
- 需要的工具/数据
- 是否需要多步骤

### 2. 执行任务
按类型调用相应能力：
- `query_info` → 搜索 / API / 读文件
- `generate_content` → 生成文案/代码
- `execute_command` → 终端执行（注意安全）
- `analyze_data` → 文件读取 + 分析

### 3. 收集 evidence（关键）
在执行过程中，**主动记录**以下信息到 `evidence`：

| 字段 | 类型 | 内容 | 示例 |
|------|------|------|------|
| `executed_commands` | array | 执行的 shell 命令 + 输出摘要 | `[{cmd: "ls -la", output_summary: "返回 3 个文件", at: 1234}]` |
| `read_files` | array | 读取的文件 + 用途 | `[{path: "/etc/hosts", purpose: "检查 DNS 配置", at: 1234}]` |
| `searches` | array | 搜索关键词 + 引擎 | `[{query: "北京天气", engine: "web", at: 1234}]` |
| `tool_calls` | array | 调用的工具 + 入参/出参摘要 | `[{tool: "web_search", args: {q: "..."}, result_summary: "...", at: 1234}]` |
| `thinking` | string | 推理思路（1-3 句话） | `"用户问天气 → 优先用 wttr.in → 解析 JSON → 输出中文"` |

**空数组也要保留字段**（空 = 没用到该类依据，不是缺失）。

### 4. 提交结果
```
POST http://localhost:4567/api/task/complete
Content-Type: application/json

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
    "read_files": [...],
    "searches": [...],
    "tool_calls": [...],
    "thinking": "..."
  },
  "context_summary": {
    "session_id": "sess-xxx",
    "active_conversations": [...],
    "global_state": {
      "current_focus": "...",
      "scheduled_tasks": [],
      "alerts": []
    }
  }
}
```

提交后**立即回到轮询循环**。

---

## 完整示例

**收到任务**：
```json
{
  "id": "task-1784726397084-1",
  "type": "query_info",
  "data": {"content": "查询当前磁盘大小", "from_user": "manual-input"}
}
```

**执行过程**：
1. 解析意图：查询系统磁盘使用情况
2. 执行 `df -h /`，记录到 `executed_commands`
3. 整理结果：148G 总 / 95G 已用 / 46G 可用 / 68%
4. 写出 thinking：用户要磁盘信息 → 用 df 命令 → 整理关键字段

**提交**：
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
    "tool_calls": [],
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

## 接口速查表

| 用途 | 方法 | 路径 |
|------|------|------|
| 心跳保活 | GET | `/api/heartbeat` |
| 长轮询 | GET | `/api/task/poll?timeout=30` |
| 提交结果（含 evidence） | POST | `/api/task/complete` |
| 任务详情 | GET | `/api/tasks/:id` |
| 任务依据 | GET | `/api/tasks/:id/evidence` |
| 重试任务 | POST | `/api/tasks/:id/retry` |
| 系统日志 | GET | `/api/logs?level=&source=&limit=` |

---

## 错误处理

| 场景 | 处理 |
|------|------|
| 心跳失败 | 继续，3 次失败 → 报告离线 |
| 轮询失败 | 等 5 秒重试 |
| 任务执行失败 | `status="failed"` 提交，仍写 evidence（说明失败原因） |
| Bridge 离线 | 每 10 秒重试心跳 |

---

## 注意事项

1. **evidence 必须填** —— 即使是空数组也要给，5 个字段一个不能少
2. **thinking 不能空** —— 至少一句话说明推理过程
3. **summary 简洁** —— 一句话说清结论，细节放 `details`
4. **心跳不能停** —— 即使在执行任务中也要继续（建议并行）
5. **长轮询阻塞** —— 一次最多 30 秒，不要重复发
6. **持续运行** —— 启动后不主动停止，等用户明确指令
7. **持续轮询** —— 如果当前没有任务，持续轮询，直到有任务
