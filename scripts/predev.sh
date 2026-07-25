#!/usr/bin/env bash
# 自动清理占用指定端口的旧 ai-bridge 进程，避免 EADDRINUSE
# v5.5.6: 优先使用 SIGTERM，超时后再 SIGKILL，避免数据损坏
PORT="${1:-4567}"
PIDS=$(fuser ${PORT}/tcp 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "[predev] 端口 ${PORT} 被以下进程占用: $PIDS"
  for p in $PIDS; do
    CMD=$(ps -p $p -o cmd= --no-headers 2>/dev/null)
    if echo "$CMD" | grep -qE "tsx.*ai-bridge|tsx.*weixin-bridge|tsx.*src/index|node.*dist/index"; then
      echo "[predev] 优雅终止 ai-bridge 进程 $p: $CMD"
      kill -TERM $p 2>/dev/null
      # 等待最多 5 秒
      for i in {1..10}; do
        if ! kill -0 $p 2>/dev/null; then
          echo "[predev] 进程 $p 已终止"
          break
        fi
        sleep 0.5
      done
      if kill -0 $p 2>/dev/null; then
        echo "[predev] 进程 $p 未响应，强制终止"
        kill -9 $p 2>/dev/null
      fi
    else
      echo "[predev] ⚠️  进程 $p 不是 ai-bridge，跳过: $CMD"
    fi
  done
  sleep 1
fi
