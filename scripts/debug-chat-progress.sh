#!/usr/bin/env bash
set -e

PORT=4677
BASE="http://localhost:${PORT}"
DATA_DIR="/tmp/ai-bridge-debug-chat-progress"
USER="admin"
PASS="admin123"
SESSION="test-progress"

rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

# 启动临时服务（后台）
PORT="$PORT" AIBRIDGE_DATA_DIR="$DATA_DIR" ILINK_MOCK=1 node src/index.js &
SERVER_PID=$!

# 等待服务就绪
for i in {1..50}; do
  if curl -s "$BASE/health" > /dev/null 2>&1; then break; fi
  sleep 0.2
done

echo "==> 服务已启动: $BASE (pid $SERVER_PID)"

# 登录获取 token
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | jq -r '.token')
echo "==> TOKEN: $TOKEN"

# 创建带指定 id 的会话
echo "==> 创建会话（传入 id=$SESSION）"
curl -s -X POST "$BASE/api/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$SESSION\",\"name\":\"进度测试会话\"}" | jq .

# 发送 chat 消息
echo "==> 发送 chat 消息（session_id=$SESSION）"
CHAT_TASK=$(curl -s -X POST "$BASE/api/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SESSION\",\"content\":\"帮我查一下磁盘空间\"}" | jq -r '.task.id')
echo "==> CHAT TASK: $CHAT_TASK"

# 查询所有会话
echo "==> GET /api/sessions"
curl -s -X GET "$BASE/api/sessions" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 查询该会话的消息
echo "==> GET /api/chat/$SESSION/messages"
curl -s -X GET "$BASE/api/chat/$SESSION/messages" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 查询所有任务，核对 session_id 一致性
echo "==> GET /api/tasks"
curl -s -X GET "$BASE/api/tasks" \
  -H "Authorization: Bearer $TOKEN" | jq 'map({id, type, session_id, source, status, data: .data?.content})'

# 清理
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
rm -rf "$DATA_DIR"
