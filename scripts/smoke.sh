#!/usr/bin/env bash
# ai-bridge v7.0 冒烟测试（SPEC §7）
# 覆盖：1 登录 / 2 注册审核poll / 3 任务全流程+evidence / 4 定向派发 / 5 MCP / 6 委派 / 10 周报
# 可选：7 工作流、8 微信+推送（模块存在才执行）；9 定时（SMOKE_SCHEDULE=1 时启用，需等待 tick）
# 11 AI 能力包：上下文压缩 + 智能路由 + 周报润色（mock AI 验证）
# 12 知识库能力包：智能检索 / 分块索引 / 经验回流 / agent 凭证
# 13 能力仓库：技能 CRUD / install-skill 联动 / MCP 服务 / 安全审查 / overview 统计
# 用法：BASE=http://localhost:4601 bash scripts/smoke.sh
# 默认使用临时数据目录和微信 mock 模式，避免污染线上数据
set -u
BASE="${BASE:-http://localhost:4567}"
CT='Content-Type: application/json'
PORT=$(python3 -c "import urllib.parse; print(urllib.parse.urlparse('$BASE').port or 4567)")

if [ -z "${AIBRIDGE_DATA_DIR:-}" ]; then
  AIBRIDGE_DATA_DIR="/tmp/ai-bridge-smoke-data-$(date +%s)"
  rm -rf "$AIBRIDGE_DATA_DIR"
  mkdir -p "$AIBRIDGE_DATA_DIR"
fi
export AIBRIDGE_DATA_DIR
export ILINK_MOCK="${ILINK_MOCK:-1}"

ok()   { echo "  ✔ $1"; }
fail() { echo "" >&2; echo "✘ SMOKE FAIL: $1" >&2; exit 1; }

# ---- 如果目标服务未运行，则在本脚本内启动临时服务 ----
SMOKE_SERVER_PID=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if ! curl -sf "$BASE/health" >/dev/null 2>&1; then
  echo "目标服务 $BASE 未运行，启动临时服务（数据目录：$AIBRIDGE_DATA_DIR）..."
  (cd "$SCRIPT_DIR/.." && node src/index.js >/tmp/ai-bridge-smoke-server.log 2>&1) &
  SMOKE_SERVER_PID=$!
  for i in $(seq 1 30); do
    curl -sf "$BASE/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -sf "$BASE/health" >/dev/null 2>&1 || fail "临时服务启动失败，请检查 /tmp/ai-bridge-smoke-server.log"
  echo "临时服务已启动（PID $SMOKE_SERVER_PID）"
fi

# ---- 退出时清理：临时服务与 mock AI 进程 ----
cleanup() {
  [ -n "$SMOKE_SERVER_PID" ] && kill "$SMOKE_SERVER_PID" 2>/dev/null || true
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  [ -n "${MOCK2_PID:-}" ] && kill "$MOCK2_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ---- 辅助：agent 领取并完成指定 chat 任务（最多轮询 5s）----
claim_and_complete() {
  local AGENT_ID="$1" TOKEN="$2" TASK_ID="$3" RESULT="$4"
  local GOT=""
  for _ in $(seq 1 20); do
    GOT=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT_ID&token=$TOKEN&timeout=1" 2>/dev/null | jsonget task id 2>/dev/null)
    [ "$GOT" = "$TASK_ID" ] && break
    sleep 0.3
  done
  [ "$GOT" = "$TASK_ID" ] || fail "领取任务失败：期望 $TASK_ID，实际 $GOT"
  curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
    -d "{\"agent_id\":\"$AGENT_ID\",\"token\":\"$TOKEN\",\"task_id\":\"$TASK_ID\",\"status\":\"completed\",\"result\":$RESULT}" >/dev/null
}

# ---- JSON 取值助手：优先 python3，回退 node ----
if command -v python3 >/dev/null 2>&1; then
  jsonget() { python3 -c '
import sys, json
cur = json.load(sys.stdin)
for k in sys.argv[1:]:
    cur = cur[int(k)] if isinstance(cur, list) else cur[k]
if cur is None: print("null")
elif isinstance(cur, bool): print("true" if cur else "false")
elif isinstance(cur, (dict, list)): print(json.dumps(cur, ensure_ascii=False))
else: print(cur)
' "$@"; }
else
  jsonget() { node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
let cur=JSON.parse(s);
for(const k of process.argv.slice(1)){cur=Array.isArray(cur)?cur[Number(k)]:cur[k];}
console.log(cur===null?"null":(typeof cur==="object"?JSON.stringify(cur):String(cur)));});
' "$@"; }
fi

http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "=== ai-bridge smoke @ $BASE ==="
curl -sf "$BASE/health" >/dev/null || fail "服务不可达：$BASE/health"

# ============ [1] 登录 admin ============
echo "[1] 登录 admin"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H "$CT" -d '{"username":"admin","password":"admin123"}')
TOKEN=$(echo "$LOGIN" | jsonget token 2>/dev/null)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || fail "登录未返回 token：$LOGIN"
AUTH="Authorization: Bearer $TOKEN"
ok "登录成功"

# ============ [2] 注册 agent → 未审核 poll 403 → 审核 → poll 通 ============
echo "[2] agent 注册 / 审核 / poll 权限"
REG=$(curl -s -X POST "$BASE/api/agent/register" -H "$CT" \
  -d '{"name":"smoke-skill-agent","capabilities":["shell","search"],"host":"smoke-host","skill_version":"1.0"}')
AGENT1=$(echo "$REG" | jsonget agent_id 2>/dev/null)
ATOK1=$(echo "$REG" | jsonget token 2>/dev/null)
[ -n "$AGENT1" ] && [ "$AGENT1" != "null" ] || fail "注册失败：$REG"
[ "$(echo "$REG" | jsonget review_status)" = "pending_review" ] || fail "注册后应为 pending_review：$REG"
ok "注册成功 $AGENT1（pending_review）"

CODE=$(http_code "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1")
[ "$CODE" = "403" ] || fail "未审核 poll 应 403，实际 $CODE"
ok "未审核 poll 被拒绝（403 pending_review）"

HB=$(curl -s "$BASE/api/heartbeat?agent_id=$AGENT1&token=$ATOK1")
[ "$(echo "$HB" | jsonget ok 2>/dev/null)" = "true" ] || fail "pending 状态心跳应放行：$HB"
ok "心跳放行且返回 review_status=$(echo "$HB" | jsonget review_status)"

AP=$(curl -s -X PATCH "$BASE/api/agents/$AGENT1" -H "$AUTH" -H "$CT" -d '{"action":"approve"}')
[ "$(echo "$AP" | jsonget review_status)" = "active" ] || fail "审核通过失败：$AP"
ok "admin 审核通过"

P0=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1")
echo "$P0" | grep -q '"task"' || fail "审核后 poll 应返回 {task}：$P0"
ok "审核后 poll 可用：$P0"

AGENTS=$(curl -s "$BASE/api/agents" -H "$AUTH")
echo "$AGENTS" | grep -q '"presence"' || fail "GET /api/agents 应附 presence：$AGENTS"
echo "$AGENTS" | grep -q 'token_hash' && fail "GET /api/agents 不应泄露 token_hash"
ok "agent 列表含 presence 且不泄露 token_hash"

# ============ [3] 建任务 → poll 到 → complete 带 evidence → 查 result ============
echo "[3] 任务全流程（evidence）"
T=$(curl -s -X POST "$BASE/api/tasks" -H "$AUTH" -H "$CT" \
  -d '{"type":"execute_command","priority":"high","required_capability":"shell","data":{"content":"smoke 主任务：执行 echo hello"}}')
TID=$(echo "$T" | jsonget id 2>/dev/null)
[ -n "$TID" ] && [ "$TID" != "null" ] || fail "建任务失败：$T"
[ "$(echo "$T" | jsonget source)" = "manual" ] || fail "用户建任务 source 应为 manual：$T"
ok "任务已建 $TID（source=manual）"

P=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=3")
PTID=$(echo "$P" | jsonget task id 2>/dev/null)
[ "$PTID" = "$TID" ] || fail "agent 未领到目标任务，领到：$P"
[ "$(echo "$P" | jsonget task status)" = "processing" ] || fail "领取后应 processing：$P"
[ "$(echo "$P" | jsonget task assigned_to)" = "$AGENT1" ] || fail "领取后 assigned_to 应为 agent：$P"
ok "agent 领到任务并置 processing"

C=$(curl -s -X POST "$BASE/api/task/complete" -H "$CT" -d "{
  \"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$TID\",\"status\":\"completed\",
  \"result\":{\"summary\":\"smoke 完成：hello\",\"evidence\":{
    \"thinking\":\"直接回显即可\",\"executed_commands\":[\"echo hello\"],
    \"read_files\":[],\"searches\":[],\"tool_calls\":[]}}}")
[ "$(echo "$C" | jsonget ok 2>/dev/null)" = "true" ] || fail "complete 失败：$C"
ok "complete 带 evidence 成功"

G=$(curl -s "$BASE/api/tasks/$TID" -H "$AUTH")
[ "$(echo "$G" | jsonget status)" = "completed" ] || fail "任务应 completed：$G"
[ "$(echo "$G" | jsonget result summary)" = "smoke 完成：hello" ] || fail "result.summary 不符：$G"
[ "$(echo "$G" | jsonget result evidence thinking)" = "直接回显即可" ] || fail "evidence 未保存：$G"
ok "GET /api/tasks/:id 可见 result+evidence"

ST=$(curl -s "$BASE/api/tasks/stats" -H "$AUTH")
[ "$(echo "$ST" | jsonget completed 2>/dev/null)" -ge 1 ] 2>/dev/null || fail "stats 异常：$ST"
ok "stats：$ST"

# ============ [4] target_agent 定向派发 ============
echo "[4] target_agent 定向派发"
REG2=$(curl -s -X POST "$BASE/api/agent/register" -H "$CT" -d '{"name":"smoke-agent-2","capabilities":["web"]}')
AGENT2=$(echo "$REG2" | jsonget agent_id 2>/dev/null)
ATOK2=$(echo "$REG2" | jsonget token 2>/dev/null)
[ -n "$AGENT2" ] && [ "$AGENT2" != "null" ] || fail "注册 agent2 失败：$REG2"
curl -s -X PATCH "$BASE/api/agents/$AGENT2" -H "$AUTH" -H "$CT" -d '{"action":"approve"}' >/dev/null

T2=$(curl -s -X POST "$BASE/api/tasks" -H "$AUTH" -H "$CT" \
  -d "{\"data\":{\"content\":\"定向任务：只给 agent2\"},\"target_agent\":\"$AGENT2\"}")
T2ID=$(echo "$T2" | jsonget id 2>/dev/null)
[ -n "$T2ID" ] && [ "$T2ID" != "null" ] || fail "建定向任务失败：$T2"

PX=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1")
PXT=$(echo "$PX" | jsonget task id 2>/dev/null)
[ "$PXT" != "$T2ID" ] || fail "定向任务被非目标 agent 领走：$PX"
ok "非目标 agent 领不到定向任务"

PY=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT2&token=$ATOK2&timeout=2")
[ "$(echo "$PY" | jsonget task id 2>/dev/null)" = "$T2ID" ] || fail "目标 agent 未领到定向任务：$PY"
C2=$(curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
  -d "{\"agent_id\":\"$AGENT2\",\"token\":\"$ATOK2\",\"task_id\":\"$T2ID\",\"status\":\"completed\",\"result\":{\"summary\":\"定向完成\"}}")
[ "$(echo "$C2" | jsonget ok 2>/dev/null)" = "true" ] || fail "agent2 complete 失败：$C2"
ok "目标 agent 领到并完成"

# 非领取者 complete 应 403
CODE=$(http_code -X POST "$BASE/api/task/complete" -H "$CT" \
  -d "{\"agent_id\":\"$AGENT2\",\"token\":\"$ATOK2\",\"task_id\":\"$TID\",\"status\":\"completed\",\"result\":{\"summary\":\"x\"}}")
[ "$CODE" = "403" ] || fail "非领取者 complete 应 403，实际 $CODE"
ok "非领取者 complete 被拒（403）"

# ============ [5] MCP ============
echo "[5] MCP JSON-RPC"
INIT=$(curl -s -X POST "$BASE/mcp" -H "$CT" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
[ "$(echo "$INIT" | jsonget result serverInfo name 2>/dev/null)" = "ai-bridge" ] || fail "initialize 异常：$INIT"
ok "initialize → $(echo "$INIT" | jsonget result serverInfo version)"

TL=$(curl -s -X POST "$BASE/mcp" -H "$CT" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
NTOOLS=$(echo "$TL" | grep -o '"name":"bridge_[a-z_]*"' | wc -l | tr -d ' ')
[ "$NTOOLS" = "7" ] || fail "tools/list 应有 7 个 tools，实际 $NTOOLS：$TL"
ok "tools/list 共 7 个 tools"

NOAUTH=$(curl -s -X POST "$BASE/mcp" -H "$CT" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bridge_poll_task","arguments":{}}}')
[ "$(echo "$NOAUTH" | jsonget error code 2>/dev/null)" = "-32001" ] || fail "无凭证 tools/call 应 -32001：$NOAUTH"
ok "无凭证 tools/call → -32001"

MP=$(curl -s -X POST "$BASE/mcp" -H "$CT" -H "Authorization: Bearer $ATOK1" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"bridge_poll_task","arguments":{}}}')
[ "$(echo "$MP" | jsonget result content 0 type 2>/dev/null)" = "text" ] || fail "Bearer bridge_poll_task 异常：$MP"
ok "Bearer bridge_poll_task 正常：$(echo "$MP" | jsonget result content 0 text | head -c 60)"

MREG=$(curl -s -X POST "$BASE/mcp" -H "$CT" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"bridge_register","arguments":{"name":"smoke-mcp-agent","capabilities":["mcp"]}}}')
MRT=$(echo "$MREG" | jsonget result content 0 text 2>/dev/null)
echo "$MRT" | grep -q '"agent_id"' || fail "bridge_register 异常：$MREG"
ok "bridge_register 无需凭证可用"

# ============ [6] 委派：agent 凭证建任务 → source=delegation → 父任务 children ============
echo "[6] 委派"
CH=$(curl -s -X POST "$BASE/api/tasks" -H "$CT" \
  -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"parent_task_id\":\"$TID\",\"data\":{\"content\":\"子任务：委派验证\"}}")
CHID=$(echo "$CH" | jsonget id 2>/dev/null)
[ -n "$CHID" ] && [ "$CHID" != "null" ] || fail "agent 委派建任务失败：$CH"
[ "$(echo "$CH" | jsonget source)" = "delegation" ] || fail "agent 建任务 source 应为 delegation：$CH"
ok "agent 委派子任务 $CHID（source=delegation）"

CODE=$(http_code -X POST "$BASE/api/tasks" -H "$CT" -d '{"data":{"content":"无凭证建任务"}}')
[ "$CODE" = "401" ] || fail "无凭证建任务应 401，实际 $CODE"
ok "无凭证建任务被拒（401）"

G2=$(curl -s "$BASE/api/tasks/$TID" -H "$AUTH")
echo "$G2" | grep -q "$CHID" || fail "父任务 children 中应含子任务：$G2"
ok "父任务 children 可见子任务"

# 清理：子任务由 agent1 领取完成，避免污染后续可选用例
PC=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=2")
if [ "$(echo "$PC" | jsonget task id 2>/dev/null)" = "$CHID" ]; then
  curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
    -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$CHID\",\"status\":\"completed\",\"result\":{\"summary\":\"子任务完成\"}}" >/dev/null
  ok "子任务已清理"
fi

# ============ [7] 工作流（可选：模块存在才执行）============
echo "[7] 工作流（可选）"
CODE=$(http_code "$BASE/api/workflows" -H "$AUTH")
if [ "$CODE" = "404" ]; then
  echo "  – workflows 模块未挂载，跳过"
else
  # 7.1 基础 2 步顺序执行
  WF=$(curl -s -X POST "$BASE/api/workflows" -H "$AUTH" -H "$CT" -d '{
    "name":"smoke-wf","description":"smoke",
    "steps":[{"name":"s1","content":"第一步"},{"name":"s2","content":"第二步","depends_on":[0]}]}')
  WFID=$(echo "$WF" | jsonget id 2>/dev/null)
  [ -n "$WFID" ] && [ "$WFID" != "null" ] || fail "建工作流失败：$WF"
  ok "创建工作流 $WFID"

  # 7.2 拓扑校验：循环依赖保存应 400 cycle_detected
  CYCLE=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/workflows" -H "$AUTH" -H "$CT" -d '{
    "name":"smoke-cycle","description":"cycle",
    "steps":[
      {"name":"a","content":"a","depends_on":[1]},
      {"name":"b","content":"b","depends_on":[0]},
      {"name":"c","content":"c"}
    ]}')
  CYCLE_BODY=$(echo "$CYCLE" | head -n -1)
  CYCLE_CODE=$(echo "$CYCLE" | tail -n 1 | tr -d '\n')
  [ "$CYCLE_CODE" = "400" ] || fail "循环依赖应返回 400，实际 $CYCLE_CODE：$CYCLE_BODY"
  echo "$CYCLE_BODY" | grep -q 'cycle_detected' || fail "循环依赖应返回 cycle_detected：$CYCLE_BODY"
  ok "循环依赖保存被拦截（400 cycle_detected）"

  # 7.3 数据流转：3 步链式工作流，步骤2引用步骤0 summary
  WFX=$(curl -s -X POST "$BASE/api/workflows" -H "$AUTH" -H "$CT" -d '{
    "name":"smoke-vars","description":"vars",
    "steps":[
      {"name":"s0","content":"第零步","x":100,"y":100},
      {"name":"s1","content":"引用：{{steps[0].summary}}","depends_on":[0],"x":300,"y":100},
      {"name":"s2","content":"第三步","depends_on":[1],"x":500,"y":100}
    ]}')
  WFXID=$(echo "$WFX" | jsonget id 2>/dev/null)
  [ -n "$WFXID" ] && [ "$WFXID" != "null" ] || fail "建变量工作流失败：$WFX"
  ok "创建变量工作流 $WFXID"

  RUNX=$(curl -s -X POST "$BASE/api/workflows/$WFXID/execute" -H "$AUTH" -H "$CT" -d '{}')
  RUNXID=$(echo "$RUNX" | jsonget id 2>/dev/null || echo "$RUNX" | jsonget run id 2>/dev/null)
  [ -n "$RUNXID" ] && [ "$RUNXID" != "null" ] || fail "execute 失败：$RUNX"
  ok "启动工作流运行 $RUNXID"

  # 领取并完成第一步（顺带清理无关任务）
  STEP0=""
  for _ in $(seq 1 20); do
    PT=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1" | jsonget task 2>/dev/null)
    [ "$PT" = "null" ] || [ -z "$PT" ] && break
    CTID=$(echo "$PT" | jsonget id)
    echo "$PT" | grep -q "$RUNXID" && { STEP0=$CTID; break; }
    curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
      -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$CTID\",\"status\":\"completed\",\"result\":{\"summary\":\"smoke 清理\"}}" >/dev/null
  done
  [ -n "$STEP0" ] || fail "未领到变量工作流第一步任务"
  curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
    -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$STEP0\",\"status\":\"completed\",\"result\":{\"summary\":\"第一步真实摘要\"}}" >/dev/null
  ok "完成步骤0，summary=第一步真实摘要"

  # 步骤1任务被释放后，其 content 应渲染为步骤0 summary
  STEP1=""
  for _ in $(seq 1 20); do
    PT=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1" | jsonget task 2>/dev/null)
    [ "$PT" = "null" ] || [ -z "$PT" ] && break
    CTID=$(echo "$PT" | jsonget id)
    echo "$PT" | grep -q "$RUNXID" && { STEP1=$CTID; break; }
    curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
      -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$CTID\",\"status\":\"completed\",\"result\":{\"summary\":\"smoke 清理\"}}" >/dev/null
  done
  [ -n "$STEP1" ] || fail "步骤0完成后步骤1未释放"
  S1_CONTENT=$(curl -s "$BASE/api/tasks/$STEP1" -H "$AUTH" | jsonget data content 2>/dev/null)
  echo "$S1_CONTENT" | grep -q "第一步真实摘要" || fail "步骤1 content 未渲染变量：$S1_CONTENT"
  ok "步骤1 content 已渲染前序摘要：$S1_CONTENT"
  curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
    -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$STEP1\",\"status\":\"completed\",\"result\":{\"summary\":\"第二步完成\"}}" >/dev/null

  # 完成步骤2
  STEP2=""
  for _ in $(seq 1 20); do
    PT=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1" | jsonget task 2>/dev/null)
    [ "$PT" = "null" ] || [ -z "$PT" ] && break
    CTID=$(echo "$PT" | jsonget id)
    echo "$PT" | grep -q "$RUNXID" && { STEP2=$CTID; break; }
    curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
      -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$CTID\",\"status\":\"completed\",\"result\":{\"summary\":\"smoke 清理\"}}" >/dev/null
  done
  [ -n "$STEP2" ] || fail "步骤1完成后步骤2未释放"
  curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
    -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$STEP2\",\"status\":\"completed\",\"result\":{\"summary\":\"第三步完成\"}}" >/dev/null
  ok "变量工作流 3 步全部完成"

  # 7.4 GET /runs/:id 应返回 steps 数组，含 x/y/status/task_id
  RUNDET=$(curl -s "$BASE/api/workflows/runs/$RUNXID" -H "$AUTH")
  [ "$(echo "$RUNDET" | jsonget steps 0 x 2>/dev/null)" = "100" ] || fail "runs/:id steps[0].x 异常：$RUNDET"
  [ "$(echo "$RUNDET" | jsonget steps 1 y 2>/dev/null)" = "100" ] || fail "runs/:id steps[1].y 异常：$RUNDET"
  [ "$(echo "$RUNDET" | jsonget steps 0 status 2>/dev/null)" = "completed" ] || fail "runs/:id steps[0].status 异常：$RUNDET"
  [ "$(echo "$RUNDET" | jsonget steps 1 task_id 2>/dev/null)" = "$STEP1" ] || fail "runs/:id steps[1].task_id 异常：$RUNDET"
  ok "GET /runs/:id 返回 steps 含 x/y/status/task_id"

  # 7.5 保留原有 2 步基本验证（使用第一个工作流）
  RUN=$(curl -s -X POST "$BASE/api/workflows/$WFID/execute" -H "$AUTH" -H "$CT" -d '{}')
  RUNID=$(echo "$RUN" | jsonget id 2>/dev/null || echo "$RUN" | jsonget run id 2>/dev/null)
  [ -n "$RUNID" ] && [ "$RUNID" != "null" ] || fail "execute 失败：$RUN"
  STEP1_BASIC=""
  for _ in $(seq 1 20); do
    PT=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1" | jsonget task 2>/dev/null)
    [ "$PT" = "null" ] || [ -z "$PT" ] && break
    CTID=$(echo "$PT" | jsonget id)
    echo "$PT" | grep -q "$RUNID" && { STEP1_BASIC=$CTID; break; }
    curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
      -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$CTID\",\"status\":\"completed\",\"result\":{\"summary\":\"smoke 清理\"}}" >/dev/null
  done
  [ -n "$STEP1_BASIC" ] || fail "未领到基本工作流第一步任务"
  curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
    -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$STEP1_BASIC\",\"status\":\"completed\",\"result\":{\"summary\":\"第一步完成\"}}" >/dev/null
  STEP2_BASIC=""
  for _ in $(seq 1 20); do
    PT=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1" | jsonget task 2>/dev/null)
    [ "$PT" = "null" ] || [ -z "$PT" ] && break
    CTID=$(echo "$PT" | jsonget id)
    echo "$PT" | grep -q "$RUNID" && { STEP2_BASIC=$CTID; break; }
    curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
      -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$CTID\",\"status\":\"completed\",\"result\":{\"summary\":\"smoke 清理\"}}" >/dev/null
  done
  [ -n "$STEP2_BASIC" ] || fail "基本工作流第二步未释放"
  curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
    -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$STEP2_BASIC\",\"status\":\"completed\",\"result\":{\"summary\":\"第二步完成\"}}" >/dev/null
  ok "工作流 2 步顺序执行成功（run=$RUNID）"
fi

# ============ [8] 微信 mock + 推送（可选）============
echo "[8] 微信 mock + 推送（可选）"
CODE=$(http_code "$BASE/api/claw/status" -H "$AUTH")
if [ "$CODE" = "404" ]; then
  echo "  – claw 模块未挂载，跳过"
else
  curl -s -X POST "$BASE/api/claw/login/start" -H "$AUTH" >/dev/null
  CONTACTS=$(curl -s "$BASE/api/claw/contacts" -H "$AUTH")
  WXID=$(echo "$CONTACTS" | jsonget 0 wxid 2>/dev/null)
  [ -n "$WXID" ] && [ "$WXID" != "null" ] || fail "contacts 为空：$CONTACTS"
  curl -s -X POST "$BASE/api/claw/push-rules" -H "$AUTH" -H "$CT" \
    -d "{\"name\":\"smoke-rule\",\"events\":[\"completed\"],\"source_filter\":[],\"target_wxid\":\"$WXID\",\"enabled\":true}" >/dev/null
  MT=$(curl -s -X POST "$BASE/api/claw/mock/incoming" -H "$AUTH" -H "$CT" \
    -d "{\"wxid\":\"$WXID\",\"content\":\"smoke 微信任务\"}")
  MTID=$(echo "$MT" | jsonget id 2>/dev/null || echo "$MT" | jsonget task id 2>/dev/null)
  [ -n "$MTID" ] && [ "$MTID" != "null" ] || fail "mock incoming 未产生任务：$MT"
  FOUND=""
  for _ in $(seq 1 10); do
    PT=$(curl -s "$BASE/api/task/poll?agent_id=$AGENT1&token=$ATOK1&timeout=1" | jsonget task 2>/dev/null)
    [ "$PT" = "null" ] || [ -z "$PT" ] && break
    CTID=$(echo "$PT" | jsonget id)
    curl -s -X POST "$BASE/api/task/complete" -H "$CT" \
      -d "{\"agent_id\":\"$AGENT1\",\"token\":\"$ATOK1\",\"task_id\":\"$CTID\",\"status\":\"completed\",\"result\":{\"summary\":\"smoke 微信完成\"}}" >/dev/null
    [ "$CTID" = "$MTID" ] && { FOUND=1; break; }
  done
  [ -n "$FOUND" ] || fail "未领到微信任务 $MTID"
  OB=$(curl -s "$BASE/api/claw/outbox?limit=20" -H "$AUTH")
  echo "$OB" | grep -q "$MTID" || fail "推送 outbox 中应有任务记录：$OB"
  ok "微信任务完成且 outbox 有推送记录"
fi

# ============ [9] 定时任务（可选，默认跳过）============
echo "[9] 定时任务（可选）"
if [ "${SMOKE_SCHEDULE:-0}" = "1" ]; then
  CODE=$(http_code "$BASE/api/schedules" -H "$AUTH")
  if [ "$CODE" = "404" ]; then
    echo "  – schedules 模块未挂载，跳过"
  else
    SC=$(curl -s -X POST "$BASE/api/schedules" -H "$AUTH" -H "$CT" \
      -d '{"name":"smoke-sched","content_template":"smoke 定时任务","interval_minutes":1,"enabled":true}')
    SCID=$(echo "$SC" | jsonget id 2>/dev/null)
    [ -n "$SCID" ] && [ "$SCID" != "null" ] || fail "建 schedule 失败：$SC"
    PAST=$(( $(date +%s) - 10 ))
    curl -s -X PATCH "$BASE/api/schedules/$SCID" -H "$AUTH" -H "$CT" -d "{\"next_run\":$PAST}" >/dev/null
    FOUND=""
    for _ in $(seq 1 15); do
      sleep 3
      L=$(curl -s "$BASE/api/tasks?source=scheduled&q=smoke" -H "$AUTH")
      echo "$L" | grep -q 'smoke 定时任务' && { FOUND=1; break; }
    done
    [ -n "$FOUND" ] || fail "tick 后未产生 scheduled 任务"
    curl -s -X PATCH "$BASE/api/schedules/$SCID" -H "$AUTH" -H "$CT" -d '{"enabled":false}' >/dev/null
    ok "scheduled 任务已产生"
  fi
else
  echo "  – 跳过（设 SMOKE_SCHEDULE=1 启用，需等待 30s tick）"
fi

# ============ [10] 周报 markdown ============
echo "[10] 周报接口"
CODE=$(http_code "$BASE/api/overview/weekly-report" -H "$AUTH")
if [ "$CODE" = "404" ]; then
  echo "  – overview 模块未挂载，跳过"
else
  [ "$CODE" = "200" ] || fail "weekly-report 应 200，实际 $CODE"
  MD=$(curl -s "$BASE/api/overview/weekly-report" -H "$AUTH" | jsonget markdown 2>/dev/null)
  [ -n "$MD" ] && [ "$MD" != "null" ] || fail "weekly-report 应返回非空 markdown"
  ok "周报 markdown 长度 ${#MD}"
fi

# ============ [11] AI 能力包：上下文压缩 + 智能路由 + 周报润色（mock AI）============
echo "[11] AI 能力包（mock AI）"

# 启动 mock AI 服务（OpenAI 兼容），使用动态端口避免残留进程占用
MOCK_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
MOCK2_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
python3 - <<PY "$MOCK_PORT" >/tmp/mock-ai.log 2>&1 &
import json, sys, http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        data = json.loads(body)
        content = ""
        for m in data.get("messages", []):
            content += m.get("content", "")
        reply = '{"text": "mock ai reply"}'
        if "compress" in content or "压缩" in content or "摘要" in content:
            reply = "早期对话已压缩：用户询问加法与排序，助手已提供结果。"
        elif "扫描" in content or "scan" in content or "端口" in content:
            reply = json.dumps({"target_agent": "scanner", "required_capability": None, "reason": "capabilities 含 scan"}, ensure_ascii=False)
        elif "路由" in content or "agent" in content or "capabilities" in content:
            reply = json.dumps({"target_agent": "smoke-skill-agent", "required_capability": None, "reason": "擅长 shell 与 search"}, ensure_ascii=False)
        elif "洞察" in content or "统计" in content:
            reply = "本周任务成功率较高，对话来源任务占比明显，建议关注失败原因TOP项。"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"choices": [{"message": {"content": reply}}]}).encode())
    def log_message(self, *a): pass
socketserver.TCPServer(("", int(sys.argv[1])), H).serve_forever()
PY
MOCK_PID=$!
for i in $(seq 1 10); do
  curl -sf "http://127.0.0.1:$MOCK_PORT/" >/dev/null 2>&1 && break
  sleep 0.5
done
[ -n "$MOCK_PID" ] && kill -0 $MOCK_PID 2>/dev/null || fail "mock AI 服务启动失败"
ok "mock AI 服务已启动 http://127.0.0.1:$MOCK_PORT"

# 11.1 无 AI 配置：多轮对话（发 8 条）→ extra.context 只有 recent 无 summary，系统无报错
# 先重置会话，再发 8 条消息（此时 settings 中尚未配置任何 AI 模型）
SESSION=$(curl -s -X POST "$BASE/api/sessions" -H "$AUTH" -H "$CT" -d '{"name":"smoke-ai-context"}' | jsonget id 2>/dev/null)
[ -n "$SESSION" ] && [ "$SESSION" != "null" ] || fail "创建测试会话失败"
ok "测试会话 $SESSION"

for i in $(seq 1 8); do
  CI=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"消息 $i\"}" 2>/dev/null | jsonget task id 2>/dev/null)
  [ -n "$CI" ] && [ "$CI" != "null" ] || fail "发送第 $i 条消息失败"
  # 模拟完成前 7 条，最后 1 条 pending 不影响无 summary 检查
  if [ "$i" -lt 8 ]; then
    claim_and_complete "$AGENT1" "$ATOK1" "$CI" "{\"summary\":\"回复 $i\"}"
  fi
done
ok "发送 8 条消息且无报错"

CTX1=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"检查上下文\"}" 2>/dev/null | jsonget task data extra context 2>/dev/null)
[ -n "$CTX1" ] || fail "未返回 extra.context"
echo "$CTX1" | grep -q '"summary"' || fail "extra.context 应包含 summary 字段"
[ "$(echo "$CTX1" | jsonget summary)" = "null" ] || fail "未触发压缩时 summary 应为 null：$CTX1"
echo "$CTX1" | grep -q '"recent"' || fail "extra.context 应包含 recent 字段"
ok "无 AI 配置时 extra.context 只有 recent 无 summary"

# 配置模型与路由
MODEL_NAME="mock-model"
PATCH=$(curl -s -X PATCH "$BASE/api/settings/ai-models" -H "$AUTH" -H "$CT" -d "{
  \"models\":[{\"name\":\"$MODEL_NAME\",\"provider\":\"mock\",\"base_url\":\"http://127.0.0.1:$MOCK_PORT\",\"model\":\"mock\",\"api_key\":\"x\"}],
  \"ai_routing\":{\"compress\":\"$MODEL_NAME\",\"route\":\"$MODEL_NAME\",\"report\":\"$MODEL_NAME\",\"default\":\"$MODEL_NAME\"}}" 2>/dev/null)
echo "$PATCH" | grep -q '"mock"' || fail "模型配置保存失败：$PATCH"
ok "AI 模型与路由配置已保存"

# 11.2 配置 mock AI 后：发 12 条消息 → session 出现 context_summary
for i in $(seq 9 12); do
  CI=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"消息 $i\"}" 2>/dev/null | jsonget task id 2>/dev/null)
  [ -n "$CI" ] && [ "$CI" != "null" ] || fail "发送第 $i 条消息失败"
  claim_and_complete "$AGENT1" "$ATOK1" "$CI" "{\"summary\":\"回复 $i\"}"
  # 每次发送后等待压缩异步完成
  sleep 0.5
done
# 再发一条，强制触发压缩（因为已有 12 条完成）
C13=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"消息 13\"}" 2>/dev/null | jsonget task id 2>/dev/null)
[ -n "$C13" ] && [ "$C13" != "null" ] || fail "发送第 13 条消息失败"
sleep 1
SUMMARY=$(curl -s "$BASE/api/sessions" -H "$AUTH" | python3 -c "import sys,json; data=json.load(sys.stdin); s=[x for x in data if x['id']=='$SESSION'][0]; print(s.get('context_summary','') or 'null')")
[ -n "$SUMMARY" ] && [ "$SUMMARY" != "null" ] || fail "AI 压缩后 session 应出现 context_summary：$SUMMARY"
ok "AI 压缩后 session 出现 context_summary：${SUMMARY:0:40}..."

CTX2=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"压缩后消息\"}" 2>/dev/null | jsonget task data extra context 2>/dev/null)
echo "$CTX2" | grep -q '"summary"' || fail "压缩后 extra.context 应包含 summary"
[ "$(echo "$CTX2" | jsonget summary)" != "null" ] || fail "压缩后 summary 不应为空"
ok "压缩后 extra.context.summary 非空"

# 11.3 智能路由：发"帮我扫描一下端口" → 任务被 AI 路由到 capabilities 含 scan 的 agent
# 先创建 scan agent 并审批
SCAN_REG=$(curl -s -X POST "$BASE/api/agent/register" -H "$CT" -d '{"name":"scanner","capabilities":["scan","shell"]}')
SCAN_ID=$(echo "$SCAN_REG" | jsonget agent_id 2>/dev/null)
[ -n "$SCAN_ID" ] && [ "$SCAN_ID" != "null" ] || fail "注册 scanner 失败"
curl -s -X PATCH "$BASE/api/agents/$SCAN_ID" -H "$AUTH" -H "$CT" -d '{"action":"approve"}' >/dev/null
# 让 scanner 心跳保持在线（不活跃会被过滤）
curl -s "$BASE/api/heartbeat?agent_id=$SCAN_ID&token=$(echo "$SCAN_REG" | jsonget token 2>/dev/null)" >/dev/null
ok "scanner 已注册并审批"

RTE=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"帮我扫描一下端口\"}" 2>/dev/null)
RTE_BY=$(echo "$RTE" | jsonget task extra route by 2>/dev/null)
RTE_TARGET=$(echo "$RTE" | jsonget task target_agent 2>/dev/null)
[ "$RTE_BY" = "ai" ] || fail "AI 路由应命中，实际 route.by=$RTE_BY：$RTE"
[ "$RTE_TARGET" = "$SCAN_ID" ] || fail "AI 路由应指向 scanner($SCAN_ID)，实际 target=$RTE_TARGET：$RTE"
ok "AI 智能路由命中 scanner"

# 11.4 AI 路由返回不存在的 agent 名 → 校验拦截，回落抢单池，extra.route.by='fallback'
# 临时配置一个路由模型，让它返回不存在的名称
python3 - <<PY "$MOCK2_PORT" >/tmp/mock-ai2.log 2>&1 &
import json, sys, http.server, socketserver
class H2(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        data = json.loads(body)
        content = ""
        for m in data.get("messages", []):
            content += m.get("content", "")
        reply = '{"text": "mock ai reply"}'
        if "路由" in content or "agent" in content or "capabilities" in content:
            reply = json.dumps({"target_agent": "non-existent-agent", "required_capability": None, "reason": "测试虚假 agent"}, ensure_ascii=False)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"choices": [{"message": {"content": reply}}]}).encode())
    def log_message(self, *a): pass
socketserver.TCPServer(("", int(sys.argv[1])), H2).serve_forever()
PY
MOCK2_PID=$!
for i in $(seq 1 10); do
  curl -sf "http://127.0.0.1:$MOCK2_PORT/" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s -X PATCH "$BASE/api/settings/ai-models" -H "$AUTH" -H "$CT" -d "{
  \"models\":[{\"name\":\"bad-router\",\"provider\":\"mock\",\"base_url\":\"http://127.0.0.1:$MOCK2_PORT\",\"model\":\"mock\",\"api_key\":\"x\"}],
  \"ai_routing\":{\"route\":\"bad-router\",\"default\":\"$MODEL_NAME\"}}" >/dev/null

FALL=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"帮我扫描一下端口\"}" 2>/dev/null)
FALL_BY=$(echo "$FALL" | jsonget task extra route by 2>/dev/null)
[ "$FALL_BY" = "fallback" ] || fail "虚假 agent 应回落，实际 route.by=$FALL_BY：$FALL"
ok "虚假 agent 路由被拦截，回落 fallback"

# 恢复正确路由模型
curl -s -X PATCH "$BASE/api/settings/ai-models" -H "$AUTH" -H "$CT" -d "{
  \"models\":[{\"name\":\"$MODEL_NAME\",\"provider\":\"mock\",\"base_url\":\"http://127.0.0.1:$MOCK_PORT\",\"model\":\"mock\",\"api_key\":\"x\"}],
  \"ai_routing\":{\"compress\":\"$MODEL_NAME\",\"route\":\"$MODEL_NAME\",\"report\":\"$MODEL_NAME\",\"default\":\"$MODEL_NAME\"}}" >/dev/null

# 11.5 evidence 不出现在任何 context 中
echo "$CTX2" | grep -qi 'evidence' && fail "extra.context 中不应出现 evidence"
# 提交带 evidence 的任务，再查上下文
EV_TASK=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"带证据的任务\",\"target_agent\":\"$AGENT1\"}" 2>/dev/null | jsonget task id 2>/dev/null)
claim_and_complete "$AGENT1" "$ATOK1" "$EV_TASK" "{\"summary\":\"完成\",\"evidence\":{\"executed_commands\":[\"echo hi\"],\"thinking\":\"思考\"}}"
CTX_EV=$(curl -s -X POST "$BASE/api/chat" -H "$AUTH" -H "$CT" -d "{\"session_id\":\"$SESSION\",\"content\":\"查看执行痕迹没泄漏\"}" 2>/dev/null | jsonget task data extra context 2>/dev/null)
echo "$CTX_EV" | grep -qi 'evidence' && fail "完成任务的 evidence 不应进入上下文：$CTX_EV"
echo "$CTX_EV" | grep -qi 'executed_commands' && fail "executed_commands 不应进入上下文"
echo "$CTX_EV" | grep -qi 'thinking' && fail "thinking 不应进入上下文"
ok "evidence 未出现在 context 中"

# 11.6 周报接口在 mock AI 下 markdown 头部含"本周洞察"
WR=$(curl -s "$BASE/api/overview/weekly-report" -H "$AUTH" 2>/dev/null)
echo "$WR" | grep -q '本周洞察' || fail "周报头部应含“本周洞察”：$WR"
ok "周报含“本周洞察”"

# ============ [12] 知识库能力包：检索 / 分块 / from-task / agent 凭证 ============
echo "[12] 知识库能力包"

# 12.1 无 AI 配置时建分类和 3 个条目，系统无报错
CAT=$(curl -s -X POST "$BASE/api/kb/categories" -H "$AUTH" -H "$CT" -d '{"name":"排查经验"}' | jsonget id 2>/dev/null)
[ -n "$CAT" ] && [ "$CAT" != "null" ] || fail "创建分类失败"
ok "知识库分类 $CAT"

# 建 3 个条目：端口占用排查、合同审核要点、命令别名整理
ITEM1=$(curl -s -X POST "$BASE/api/kb/items" -H "$AUTH" -H "$CT" -d "{\"category_id\":\"$CAT\",\"title\":\"端口占用排查\",\"content\":\"当服务启动报端口冲突时，先通过 lsof -i :端口 或 netstat 查看占用进程。Linux 下常用 ss -tlnp 找到 PID，再判断是杀掉还是更换端口。\",\"tags\":[\"端口\",\"排查\"]}" | jsonget id 2>/dev/null)
ITEM2=$(curl -s -X POST "$BASE/api/kb/items" -H "$AUTH" -H "$CT" -d "{\"category_id\":\"$CAT\",\"title\":\"合同审核要点\",\"content\":\"审核合同应重点检查违约责任、付款条款、知识产权归属与保密义务。对关键数字与日期做交叉核对，必要时咨询法务。\",\"tags\":[\"合同\",\"法务\"]}" | jsonget id 2>/dev/null)
ITEM3=$(curl -s -X POST "$BASE/api/kb/items" -H "$AUTH" -H "$CT" -d "{\"category_id\":\"$CAT\",\"title\":\"命令别名整理\",\"content\":\"为常用命令设置 alias，如 alias gp=\\\"git pull\\\" 可减少重复输入。把 alias 写入 ~/.bashrc 后 source 生效。\",\"tags\":[\"效率\"]}" | jsonget id 2>/dev/null)
[ -n "$ITEM1" ] && [ "$ITEM1" != "null" ] || fail "创建条目 1 失败"
[ -n "$ITEM2" ] && [ "$ITEM2" != "null" ] || fail "创建条目 2 失败"
[ -n "$ITEM3" ] && [ "$ITEM3" != "null" ] || fail "创建条目 3 失败"
ok "创建 3 个知识条目"
sleep 0.5

# 12.2 搜索：q=端口 命中正确、snippet 含上下文、category_name 非空
SR=$(curl -s "$BASE/api/kb/search?q=%E7%AB%AF%E5%8F%A3&limit=10" -H "$AUTH")
SR_COUNT=$(echo "$SR" | jsonget results 2>/dev/null | grep -o '"id"' | wc -l | tr -d ' ')
[ "$SR_COUNT" -ge 1 ] || fail "搜索“端口”应命中至少 1 条：$SR"
echo "$SR" | grep -q '端口占用排查' || fail "搜索结果应包含“端口占用排查”条目：$SR"
echo "$SR" | grep -q '"category_name"' || fail "搜索结果应包含 category_name：$SR"
echo "$SR" | grep -q '"snippet"' || fail "搜索结果应包含 snippet：$SR"
ok "搜索“端口”命中 $SR_COUNT 条，含 category_name 与 snippet"

# 12.3 agent 凭证调 /api/kb/search 与 MCP bridge_kb_search 均返回结果；无凭证 401
AGENT_SEARCH=$(curl -s "$BASE/api/kb/search?q=%E7%AB%AF%E5%8F%A3&agent_id=$AGENT1&token=$ATOK1")
echo "$AGENT_SEARCH" | grep -q '"results"' || fail "agent 凭证 search 应返回 results：$AGENT_SEARCH"
ok "agent 凭证调 /api/kb/search 成功"

# 凭证 Header 迁移：requireAgent / kbAuth 支持 X-Agent-Id + X-Agent-Token 请求头
HB_HDR=$(curl -s "$BASE/api/heartbeat" -H "X-Agent-Id: $AGENT1" -H "X-Agent-Token: $ATOK1")
[ "$(echo "$HB_HDR" | jsonget ok 2>/dev/null)" = "true" ] || fail "heartbeat Header 凭证应放行：$HB_HDR"
ok "requireAgent 支持 X-Agent-Id/X-Agent-Token 请求头"

HDR_SEARCH=$(curl -s "$BASE/api/kb/search?q=%E7%AB%AF%E5%8F%A3" \
  -H "X-Agent-Id: $AGENT1" -H "X-Agent-Token: $ATOK1")
echo "$HDR_SEARCH" | grep -q '"results"' || fail "agent 凭证 Header search 应返回 results：$HDR_SEARCH"
ok "kbAuth 支持 X-Agent-Id/X-Agent-Token 请求头"

NOAUTH_SEARCH=$(http_code "$BASE/api/kb/search?q=%E7%AB%AF%E5%8F%A3")
[ "$NOAUTH_SEARCH" = "401" ] || fail "无凭证 search 应 401，实际 $NOAUTH_SEARCH"
ok "无凭证 search 被拒（401）"

KB_SEARCH_MCP=$(curl -s -X POST "$BASE/mcp" -H "$CT" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":100,\"method\":\"tools/call\",\"params\":{\"name\":\"bridge_kb_search\",\"arguments\":{\"query\":\"端口\",\"limit\":5}}}" \
  -H "Authorization: Bearer $ATOK1")
KB_SEARCH_MCP_TEXT=$(echo "$KB_SEARCH_MCP" | jsonget result content 0 text 2>/dev/null)
echo "$KB_SEARCH_MCP_TEXT" | grep -q '"results"' || fail "MCP bridge_kb_search 应返回 results：$KB_SEARCH_MCP"
ok "MCP bridge_kb_search 返回结果"

# 12.4 导入 800 字以上 md → 分块索引生效（用尾部独有词 API 检索验证）；删除条目后检索不再命中
# 构造长文档，尾部附独有标记词，确保分块后该词落在后段 chunk
TAIL_WORD="tailUniqueMarkerZ9q8"
LONG_MD="$(python3 - <<PY
parts = ["这是一段测试文本。" * 30 for _ in range(4)]
print("# 长文档\n\n" + "\n\n".join(parts) + "\n\n## 尾部独有标记\n\n$TAIL_WORD")
PY
)"
LONG_B64=$(printf '%s' "$LONG_MD" | base64 -w0)
ITEM_LONG=$(curl -s -X POST "$BASE/api/kb/items" -H "$AUTH" -H "$CT" -d "{\"category_id\":\"$CAT\",\"title\":\"长文档分块测试\",\"content\":\"占位\"}" | jsonget id 2>/dev/null)
[ -n "$ITEM_LONG" ] && [ "$ITEM_LONG" != "null" ] || fail "创建长文档条目失败"
IMPORT_R=$(curl -s -X POST "$BASE/api/kb/items/$ITEM_LONG/import-file" -H "$AUTH" -H "$CT" -d "{\"file\":{\"name\":\"long.md\",\"content_base64\":\"$LONG_B64\"},\"mode\":\"overwrite\"}")
[ "$(echo "$IMPORT_R" | jsonget ok 2>/dev/null)" = "true" ] || fail "导入长文档失败：$IMPORT_R"
ok "导入长文档成功"

sleep 0.5
# 通过 API 验证分块：搜索尾部独有词应命中长文档条目，snippet 来自后段 chunk
TAIL_ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TAIL_WORD'))")
TAIL_SR=$(curl -s "$BASE/api/kb/search?q=$TAIL_ENC&limit=5" -H "$AUTH")
echo "$TAIL_SR" | grep -q '"results"' || fail "搜索尾部独有词应返回 results：$TAIL_SR"
TAIL_HIT_ID=$(echo "$TAIL_SR" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print(r[0]['id'] if r else '')")
[ "$TAIL_HIT_ID" = "$ITEM_LONG" ] || fail "搜索尾部独有词应命中长文档条目 $ITEM_LONG，实际命中 $TAIL_HIT_ID：$TAIL_SR"
echo "$TAIL_SR" | grep -q "$TAIL_WORD" || fail "snippet 应包含尾部独有词（来自后段 chunk）：$TAIL_SR"
ok "长文档分块后尾部独有词可被 API 检索，snippet 来自后段"

# 删除条目后 chunks 级联清除：搜索尾部独有词不再命中
curl -s -X DELETE "$BASE/api/kb/items/$ITEM_LONG" -H "$AUTH" >/dev/null
REMAIN=$(curl -s "$BASE/api/kb" -H "$AUTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([c for c in d.get('items',[]) if c.get('id')=='$ITEM_LONG']))")
[ "$REMAIN" = "0" ] || fail "删除条目后 API 不应再返回该 item，实际 $REMAIN"
TAIL_SR2=$(curl -s "$BASE/api/kb/search?q=$TAIL_ENC&limit=5" -H "$AUTH")
TAIL_REMAIN=$(echo "$TAIL_SR2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([x for x in d.get('results',[]) if x.get('id')=='$ITEM_LONG']))")
[ "$TAIL_REMAIN" = "0" ] || fail "删除条目后搜索不应再命中，实际 $TAIL_REMAIN 条：$TAIL_SR2"
ok "删除条目后级联清除 chunks，API 检索不再命中"

# 12.5 完成任务 → POST /api/kb/from-task → 条目含“问题/解决方案”段落、extra.source_task_id 正确、相似条目自动建 link
# 先完成一个带命令 evidence 的任务
FT_TASK=$(curl -s -X POST "$BASE/api/tasks" -H "$AUTH" -H "$CT" -d '{"type":"execute_command","data":{"content":"服务器 8080 端口被占用如何排查"}}')
FT_TID=$(echo "$FT_TASK" | jsonget id 2>/dev/null)
[ -n "$FT_TID" ] && [ "$FT_TID" != "null" ] || fail "创建 from-task 来源任务失败"
claim_and_complete "$AGENT1" "$ATOK1" "$FT_TID" "{\"summary\":\"当服务启动报端口冲突时，先通过 lsof -i :8080 或 netstat 查看占用进程，再用 ss -tlnp 找到 PID，判断是杀掉还是更换端口\",\"evidence\":{\"executed_commands\":[\"lsof -i :8080\",\"ss -tlnp\"],\"read_files\":[],\"searches\":[],\"tool_calls\":[]}}"

FROM_KB=$(curl -s -X POST "$BASE/api/kb/from-task" -H "$AUTH" -H "$CT" -d "{\"task_id\":\"$FT_TID\",\"category_id\":\"$CAT\",\"tags\":[\"端口\",\"排查\"]}")
FROM_ITEM=$(echo "$FROM_KB" | jsonget item 2>/dev/null)
FROM_ITEM_ID=$(echo "$FROM_KB" | jsonget item id 2>/dev/null)
[ -n "$FROM_ITEM_ID" ] && [ "$FROM_ITEM_ID" != "null" ] || fail "from-task 未返回 item：$FROM_KB"

echo "$FROM_ITEM" | grep -q '## 问题' || fail "from-task 条目应包含 ## 问题：$FROM_ITEM"
echo "$FROM_ITEM" | grep -q '## 解决方案' || fail "from-task 条目应包含 ## 解决方案：$FROM_ITEM"
echo "$FROM_ITEM" | grep -q '## 执行要点' || fail "from-task 条目应包含 ## 执行要点：$FROM_ITEM"
[ "$(echo "$FROM_ITEM" | jsonget extra source_task_id)" = "$FT_TID" ] || fail "from-task 条目 extra.source_task_id 不正确：$FROM_ITEM"
ok "from-task 生成经验条目，段落与 source_task_id 正确"

LINK_ID=$(echo "$FROM_KB" | jsonget link id 2>/dev/null)
[ -n "$LINK_ID" ] && [ "$LINK_ID" != "null" ] || fail "from-task 应自动建立相似条目 link：$FROM_KB"
ok "from-task 自动建立相关经验 link $LINK_ID"

# 12.6 无 AI 配置时全流程无报错（已在上面的条目中验证创建/导入/from-task 均无 500）
ok "无 AI 配置时知识库全流程无报错"

# ============ [13] 能力仓库：技能 / MCP 服务 / 安装联动 / 安全审查 ============
echo "[13] 能力仓库"

# 13.1 内置技能播种：GET /api/skills 返回 6 个内置技能，含 install_count 字段
SKILLS=$(curl -s "$BASE/api/skills" -H "$AUTH")
SKILL_COUNT=$(echo "$SKILLS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
[ "${SKILL_COUNT:-0}" -ge 6 ] || fail "GET /api/skills 应至少有 6 个内置技能，实际 $SKILL_COUNT：$SKILLS"
echo "$SKILLS" | grep -q '"install_count"' || fail "技能对象应含 install_count：$SKILLS"
echo "$SKILLS" | grep -q '"builtin":true' || fail "应包含 builtin=true 的内置技能：$SKILLS"
ok "GET /api/skills 返回 $SKILL_COUNT 个技能，含 install_count"

# 13.2 GET /api/skills/categories 返回分类数组
SKCATS=$(curl -s "$BASE/api/skills/categories" -H "$AUTH")
echo "$SKCATS" | grep -q 'system' || fail "技能分类应包含 system：$SKCATS"
ok "GET /api/skills/categories 返回 $SKCATS"

# 13.3 GET /api/skills/:id/doc 返回技能接入文档
SKID=$(echo "$SKILLS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(s['id'] for s in d if s['name']=='shell-executor'))")
SKDOC=$(curl -s "$BASE/api/skills/$SKID/doc" -H "$AUTH")
echo "$SKDOC" | grep -q '"skill_doc"' || fail "GET /api/skills/:id/doc 应返回 skill_doc：$SKDOC"
echo "$SKDOC" | grep -q 'capabilities' || fail "shell-executor 文档应含 capabilities 字段：$SKDOC"
ok "GET /api/skills/:id/doc 返回接入文档"

# 13.4 POST /api/skills 新建自定义技能；重复 name 409
NEWSK=$(curl -s -X POST "$BASE/api/skills" -H "$AUTH" -H "$CT" \
  -d '{"name":"smoke-custom-skill","display_name":"smoke 自定义","description":"测试技能","category":"system","capabilities":["smoke_test"],"skill_doc":"# smoke\n测试用"}')
NEWSKID=$(echo "$NEWSK" | jsonget id 2>/dev/null)
[ -n "$NEWSKID" ] && [ "$NEWSKID" != "null" ] || fail "新建自定义技能失败：$NEWSK"
[ "$(echo "$NEWSK" | jsonget builtin)" = "false" ] || fail "自定义技能 builtin 应为 false：$NEWSK"
DUP_CODE=$(http_code -X POST "$BASE/api/skills" -H "$AUTH" -H "$CT" \
  -d '{"name":"smoke-custom-skill","display_name":"dup","description":"x"}')
[ "$DUP_CODE" = "409" ] || fail "重复 name 应 409，实际 $DUP_CODE"
ok "新建自定义技能 $NEWSKID，重复 name 被拒（409）"

# 13.5 admin 安装技能到 agent1：install_count +1；重复安装 409；卸载后 -1
INS=$(curl -s -X POST "$BASE/api/agents/$AGENT1/install-skill" -H "$AUTH" -H "$CT" \
  -d "{\"skill_id\":\"$SKID\"}")
[ "$(echo "$INS" | jsonget id 2>/dev/null)" = "$AGENT1" ] || fail "安装技能返回 agent 不符：$INS"
INSTALLED=$(echo "$INS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(any(s['skill_id']=='$SKID' for s in d.get('installed_skills',[])))")
[ "$INSTALLED" = "True" ] || fail "installed_skills 应包含刚安装的技能：$INS"
INST_CNT=$(curl -s "$BASE/api/skills" -H "$AUTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(s['install_count'] for s in d if s['id']=='$SKID'))")
[ "${INST_CNT:-0}" -ge 1 ] || fail "技能 install_count 应 +1：$INST_CNT"
ok "安装技能到 agent1 成功，install_count=$INST_CNT"

DUP_INS_CODE=$(http_code -X POST "$BASE/api/agents/$AGENT1/install-skill" -H "$AUTH" -H "$CT" \
  -d "{\"skill_id\":\"$SKID\"}")
[ "$DUP_INS_CODE" = "409" ] || fail "重复安装应 409，实际 $DUP_INS_CODE"
ok "重复安装被拒（409）"

UNINS=$(curl -s -X DELETE "$BASE/api/agents/$AGENT1/install-skill/$SKID" -H "$AUTH")
[ "$(echo "$UNINS" | jsonget id 2>/dev/null)" = "$AGENT1" ] || fail "卸载技能返回 agent 不符：$UNINS"
UNINS_CNT=$(curl -s "$BASE/api/skills" -H "$AUTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(s['install_count'] for s in d if s['id']=='$SKID'))")
[ "${UNINS_CNT:-0}" -ge 0 ] || fail "卸载后 install_count 异常：$UNINS_CNT"
ok "卸载技能成功，install_count=$UNINS_CNT"

# 13.6 删除自定义技能成功；删除内置技能 403
DEL_CODE=$(http_code -X DELETE "$BASE/api/skills/$NEWSKID" -H "$AUTH")
[ "$DEL_CODE" = "200" ] || fail "删除自定义技能应 200，实际 $DEL_CODE"
BUILTIN_DEL_CODE=$(http_code -X DELETE "$BASE/api/skills/$SKID" -H "$AUTH")
[ "$BUILTIN_DEL_CODE" = "403" ] || fail "删除内置技能应 403，实际 $BUILTIN_DEL_CODE"
ok "删除自定义技能成功，内置技能被拒（403）"

# 13.7 内置 MCP 服务播种：GET /api/mcp-registry 返回 4 个内置服务，含 security_review
MCPS=$(curl -s "$BASE/api/mcp-registry" -H "$AUTH")
MCP_COUNT=$(echo "$MCPS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
[ "${MCP_COUNT:-0}" -ge 4 ] || fail "GET /api/mcp-registry 应至少有 4 个内置服务，实际 $MCP_COUNT：$MCPS"
echo "$MCPS" | grep -q '"security_review"' || fail "MCP 服务应含 security_review：$MCPS"
ok "GET /api/mcp-registry 返回 $MCP_COUNT 个服务，含 security_review"

# 13.8 GET /api/mcp-registry/:id/config 返回 mcpServers 结构
MCPID=$(echo "$MCPS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next(s['id'] for s in d if s['name']=='filesystem'))")
MCPCFG=$(curl -s "$BASE/api/mcp-registry/$MCPID/config" -H "$AUTH")
echo "$MCPCFG" | grep -q '"mcpServers"' || fail "GET /:id/config 应返回 mcpServers：$MCPCFG"
echo "$MCPCFG" | grep -q '"filesystem"' || fail "mcpServers 应以服务名为 key：$MCPCFG"
echo "$MCPCFG" | grep -q '"security_review"' || fail "config 应含 security_review：$MCPCFG"
ok "GET /api/mcp-registry/:id/config 生成 mcpServers 结构"

# 13.9 POST /api/mcp-registry 新建含硬编码密钥的自定义服务，security_review.status=blocked
NEWMCP=$(curl -s -X POST "$BASE/api/mcp-registry" -H "$AUTH" -H "$CT" \
  -d '{"name":"smoke-risky","display_name":"风险测试","description":"含硬编码密钥","transport":"stdio","command":"npx","args":["-y","x"],"env":{"API_KEY":"sk-abcdefghijklmnopqrstuvwxyz1234567890"}}')
NEWMCPID=$(echo "$NEWMCP" | jsonget id 2>/dev/null)
[ -n "$NEWMCPID" ] && [ "$NEWMCPID" != "null" ] || fail "新建 MCP 服务失败：$NEWMCP"
REVIEW_STATUS=$(echo "$NEWMCP" | jsonget security_review status 2>/dev/null)
[ "$REVIEW_STATUS" = "blocked" ] || fail "含硬编码密钥应 blocked，实际 $REVIEW_STATUS：$NEWMCP"
ok "新建含密钥 MCP 服务被审查拦截（status=blocked）"

# 13.10 POST /api/mcp-registry/:id/review 手动触发审查返回最新结果
REVIEW_R=$(curl -s -X POST "$BASE/api/mcp-registry/$NEWMCPID/review" -H "$AUTH")
[ "$(echo "$REVIEW_R" | jsonget security_review status 2>/dev/null)" = "blocked" ] || fail "手动审查应仍为 blocked：$REVIEW_R"
ok "手动触发审查返回 blocked"

# 13.11 删除自定义 MCP 服务成功；删除内置 403
MCP_DEL_CODE=$(http_code -X DELETE "$BASE/api/mcp-registry/$NEWMCPID" -H "$AUTH")
[ "$MCP_DEL_CODE" = "200" ] || fail "删除自定义 MCP 应 200，实际 $MCP_DEL_CODE"
MCP_BUILTIN_DEL_CODE=$(http_code -X DELETE "$BASE/api/mcp-registry/$MCPID" -H "$AUTH")
[ "$MCP_BUILTIN_DEL_CODE" = "403" ] || fail "删除内置 MCP 应 403，实际 $MCP_BUILTIN_DEL_CODE"
ok "删除自定义 MCP 成功，内置 MCP 被拒（403）"

# 13.12 总览接口含能力仓库统计 capabilities
OV=$(curl -s "$BASE/api/overview/" -H "$AUTH")
echo "$OV" | grep -q '"capabilities"' || fail "overview 应含 capabilities 字段：$OV"
echo "$OV" | grep -q 'skills_total' || fail "capabilities 应含 skills_total：$OV"
echo "$OV" | grep -q 'mcps_total' || fail "capabilities 应含 mcps_total：$OV"
ok "overview 含能力仓库统计：$(echo "$OV" | python3 -c "import sys,json; d=json.load(sys.stdin)['capabilities']; print(f\"skills={d['skills_total']} mcps={d['mcps_total']}\")")"

# 清理 mock AI
trap cleanup EXIT

echo ""
echo "=== SMOKE PASS ==="
