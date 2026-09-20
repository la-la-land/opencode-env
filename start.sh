#!/usr/bin/env bash
# opencode-env / start.sh — стек-менеджер (llama.cpp + Qdrant)
#   ./start.sh all          — поднять всё (embed :8095 + main :1234 + qdrant :6333)
#   ./start.sh infra        — только инфраструктура (embed + qdrant, без LLM) — сценарий «без локальной LLM»
#   ./start.sh embed|main|qdrant
#   ./start.sh stop         — остановить llama.cpp и qdrant
#   ./start.sh health       — статус всех сервисов
# Локальная модель: Gemma 4 12B (256K, целиком в VRAM при 16 ГБ).
# Без локальной LLM (ноутбук/сервер без GPU): ./start.sh infra —
# embed/qdrant для RAG работают на CPU, а модель подключается удалённая (stack.config, /models).
set -euo pipefail
cd "$(dirname "$0")"

# --- CUDA runtime: ищем pip-пакеты nvidia (cu13) или системную CUDA ---
if [ -n "${LLMSTACK_CUDA_LIB:-}" ]; then
  export LD_LIBRARY_PATH="$LLMSTACK_CUDA_LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
  for p in "$HOME"/.local/lib/python*/site-packages/nvidia/cu13/lib \
           /usr/lib/python3*/site-packages/nvidia/cu13/lib \
           /usr/local/cuda/lib64; do
    [ -d "$p" ] && { export LD_LIBRARY_PATH="$p${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; break; }
  done
fi

BIN=./llama.cpp-bin/llama-server
EMBED=models/bge-m3-q8_0.gguf
MAIN_MODEL=models/gemma-4-12b-it-Q4_K_M.gguf
LOG=rag/main-server.log
ALIAS=local-coder

start_embed() {
  if curl -s --max-time 2 http://127.0.0.1:8095/health >/dev/null 2>&1; then
    echo "embed уже работает (:8095)"; return
  fi
  [ -x "$BIN" ] || { echo "нет $BIN — запусти ./setup.sh"; exit 1; }
  echo "старт embed bge-m3 (:8095)..."
  setsid "$BIN" -m "$EMBED" --embedding --host 127.0.0.1 --port 8095 \
    -c 8192 -b 2048 -ub 2048 --threads "$(nproc)" \
    > rag/embed-server.log 2>&1 < /dev/null &
  disown
  for i in $(seq 1 20); do
    curl -s --max-time 2 http://127.0.0.1:8095/health >/dev/null 2>&1 && { echo "embed UP"; return; }
    sleep 1
  done
  echo "embed не поднялся — см. rag/embed-server.log"
}

start_qdrant() {
  if curl -s --max-time 2 http://127.0.0.1:6333/health >/dev/null 2>&1; then
    echo "qdrant уже работает (:6333)"; return
  fi
  [ -x ./qdrant/qdrant ] || { echo "нет qdrant — запусти ./setup.sh"; exit 1; }
  echo "старт Qdrant (:6333)..."
  setsid ./qdrant/qdrant --config-path ./qdrant/config.yaml > qdrant/qdrant.log 2>&1 < /dev/null &
  disown
  for i in $(seq 1 15); do
    curl -s --max-time 2 http://127.0.0.1:6333/health >/dev/null 2>&1 && { echo "qdrant UP"; return; }
    sleep 1
  done
  echo "qdrant не поднялся — см. qdrant/qdrant.log"
}

start_main() {
  if curl -s --max-time 2 http://127.0.0.1:1234/health >/dev/null 2>&1; then
    echo "основной сервер уже работает (:1234)"; return
  fi
  [ -x "$BIN" ] || { echo "нет $BIN — запусти ./setup.sh"; return 1; }
  if [ ! -f "$MAIN_MODEL" ]; then
    echo "нет локальной модели — сценарий «без локальной LLM»: используй удалённую (stack.config REMOTE_*, выбор в /models)."
    echo "Для RAG-инфраструктуры достаточно: ./start.sh infra"
    return 0
  fi
  echo "старт Gemma 4 12B (:1234, ctx 256K, alias $ALIAS)..."
  setsid "$BIN" \
    -m "$MAIN_MODEL" -c 262144 \
    --host 127.0.0.1 --port 1234 --alias "$ALIAS" \
    --flash-attn on \
    --parallel 1 --gpu-layers "${NGL:-99}" \
    --threads 24 --threads-batch 24 --no-webui \
    > "$LOG" 2>&1 < /dev/null &
  disown
  for i in $(seq 1 90); do
    grep -q "model loaded" "$LOG" 2>/dev/null && { echo "main UP (модель загружена)"; return; }
    pgrep -f "[l]lama-server" >/dev/null || { echo "FATAL: llama-server упал — см. $LOG"; return 1; }
    sleep 2
  done
  echo "основной сервер не поднялся — см. $LOG"
}

health() {
  echo "--- статус ---"
  for s in "1234 LLM" "8095 embed" "6333 qdrant" "8000 honcho"; do
    set -- $s
    if curl -sf --max-time 2 "http://127.0.0.1:$1/health" >/dev/null 2>&1; then
      echo "  [ok]   :$1 ($2)"
    elif [ "$1" = "1234" ] && [ ! -f "$MAIN_MODEL" ]; then
      echo "  [ok]   :1234 (LLM — удалённая, локальной модели нет)"
    else
      echo "  [нет]  :$1 ($2)"
    fi
  done
}

case "${1:-all}" in
  embed)  start_embed ;;
  main)   start_main ;;
  qdrant) start_qdrant ;;
  infra)  start_embed; start_qdrant ;;
  all)    start_embed; start_qdrant; start_main ;;
  stop)
    pkill -f "llama-server" 2>/dev/null || true
    pkill -f "qdrant --config-path" 2>/dev/null || true
    echo "llama-server + qdrant остановлены (honcho в docker не трогаем)" ;;
  health) health ;;
  *) echo "usage: $0 [all|infra|embed|main|qdrant|stop|health]"; exit 1 ;;
esac