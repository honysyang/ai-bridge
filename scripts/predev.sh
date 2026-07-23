#!/usr/bin/env bash
# 自动清理占用 4567 端口的旧 ai-bridge 进程，避免 EADDRINUSE
PORT="${1:-4567}"
PIDS=$(fuser ${PORT}/tcp 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "[predev] 端口 ${PORT} 被以下进程占用: $PIDS"
  for p in $PIDS; do
    CMD=$(ps -p $p -o cmd= --no-headers 2>/dev/null)
    if echo "$CMD" | grep -qE "tsx.*ai-bridge|tsx.*weixin-bridge|tsx.*src/index"; then
      echo "[predev] 杀掉 ai-bridge 进程 $p: $CMD"
      kill -9 $p 2>/dev/null
    else
      echo "[predev] ⚠️  进程 $p 不是 ai-bridge，跳过: $CMD"
    fi
  done
  sleep 1
fi
