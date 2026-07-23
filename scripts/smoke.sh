#!/usr/bin/env bash
# ======== Smoke Test ========
# 启动后跑一遍关键端点，确认服务健康
# 用法: bash scripts/smoke.sh [PORT]
set -e

PORT="${1:-4567}"
BASE="http://localhost:${PORT}"
FAIL=0
PASS=0

check() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_status="${4:-200}"
  local body
  local status
  if [ "$method" = "GET" ]; then
    body=$(curl -s -o /tmp/smoke-body -w "%{http_code}" "${BASE}${path}" || echo "000")
  else
    body=$(curl -s -o /tmp/smoke-body -w "%{http_code}" -X "$method" "${BASE}${path}" || echo "000")
  fi
  status="$body"
  if [ "$status" = "$expected_status" ]; then
    echo "  ✅ ${name}  [${status}]  ${method} ${path}"
    PASS=$((PASS+1))
  else
    echo "  ❌ ${name}  [${status}]  ${method} ${path}  (expected ${expected_status})"
    head -c 200 /tmp/smoke-body
    echo
    FAIL=$((FAIL+1))
  fi
}

echo "== Smoke Test on ${BASE} =="

# 健康
check "health"           "GET"  "/health"                                 200
check "heartbeat"        "GET"  "/api/heartbeat"                          200
check "heartbeat-snap"   "GET"  "/api/heartbeat/snapshot"                 200

# 业务
check "stats"            "GET"  "/api/stats"                              200
check "sessions"         "GET"  "/api/sessions"                           200
check "tasks"            "GET"  "/api/tasks?limit=5"                      200
check "kb"               "GET"  "/api/kb"                                 200
check "wf"               "GET"  "/api/wf"                                 200
check "logs"             "GET"  "/api/logs?limit=5"                       200
check "claw-status"      "GET"  "/api/claw/status"                        200
check "ilink-creds"      "GET"  "/api/claw/ilink/credentials"             200
check "storage-stats"    "GET"  "/api/storage/stats"                      200

# 错误
check "404-fallback"     "GET"  "/api/xxx-not-exist"                      404
check "task-not-found"   "GET"  "/api/tasks/task-xxx-does-not-exist"      404
check "bad-task-body"    "POST" "/api/tasks"                              400

echo ""
echo "== 结果: ${PASS} passed, ${FAIL} failed =="
exit $FAIL
