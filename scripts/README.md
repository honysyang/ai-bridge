# scripts 目录说明

本目录存放开发、测试与运维辅助脚本。

## 当前维护的脚本

| 脚本 | 用途 | 运行时机 |
|------|------|----------|
| `predev.sh` | 开发前检查：清理旧进程、确认端口可用 | `npm run dev` 前自动执行 |
| `smoke.sh` | 端到端冒烟测试，覆盖关键 HTTP API | `npm run smoke` |
| `weixin-agent.js` | 微信智能体：心跳保活 + 长轮询任务 + 提交 evidence | 需要独立运行 |

### weixin-agent.js

基于 `weixin-agent.skill.md` 实现的独立 Agent 进程：

- 每 5 秒向 `GET /api/heartbeat` 发送心跳。
- 通过 `GET /api/task/poll?timeout=30` 长轮询获取待处理任务。
- 执行任务后向 `POST /api/task/complete` 提交结果与 evidence。
- 支持的任务类型：`chat`、`query_info`、`execute_command`、`generate_content`、`analyze_data`、`reply_message`、`multi_step`。

运行方式：

```bash
node scripts/weixin-agent.js
```

环境变量：

```bash
AIBRIDGE_AGENT_BASE_URL=http://localhost:4567      # ai-bridge 服务地址
AIBRIDGE_AGENT_POLL_TIMEOUT=30000                  # 长轮询超时（毫秒）
AIBRIDGE_AGENT_HEARTBEAT_INTERVAL=5000             # 心跳间隔（毫秒）
```

## 一次性/调试脚本

| 脚本 | 用途 |
|------|------|
| `inspect.mjs` | 运行时状态检查 |
| `test-kb-links.mjs` | 知识库关联一次性验证 |
| `style-compare.cjs` | 样式对比调试 |

## 已归档的 CDP 测试脚本

`deprecated/cdp-*.cjs` 是早期使用 Chrome DevTools Protocol 进行的前端 E2E 截图/测试脚本，
随版本迭代已停止维护，保留仅作历史参考。
