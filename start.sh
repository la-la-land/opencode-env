#!/usr/bin/env bash
# opencode-env / start.sh — стек-менеджер (llama.cpp embed + Qdrant)
#
#   ./start.sh all       — поднять всё: embed-сервер (:8095) + Qdrant (:6333)
#   ./start.sh embed     — только embed-сервер llama.cpp (:8095)
#   ./start.sh qdrant    — только Qdrant (:6333)
#   ./start.sh config    — показать resolved-параметры (модель, файл, размерность)
#   ./start.sh stop      — остановить llama.cpp и qdrant (honcho в docker не трогаем)
#   ./start.sh health    — статус сервисов (:8095 embed, :6333 qdrant, :8000 honcho)
#
# Локальной LLM больше нет: llama.cpp работает ТОЛЬКО как embed-сервер.
# Модель эмбеддингов и её размерность — из stack.config:
#   EMBED_MODEL=bge-m3   → ~1.2 ГБ, 1024-dim, pooling cls  (качественнее)
#   EMBED_MODEL=minilm   → 126 МБ,  384-dim, pooling mean  (маломощный ПК)
# Переопределить на лету: EMBED_MODEL=minilm ./start.sh all
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

# ---------- конфиг стека (окружение важнее файла) ----------
# Значения из окружения запоминаем ДО чтения stack.config — иначе sourced-файл
# перезаписал бы их. Окружение позволяет переопределить модель на лету.
E_EMBED_MODEL="${EMBED_MODEL:-}"
E_EMBED_FILE="${EMBED_FILE:-}"
E_EMBED_DIM="${EMBED_DIM:-}"
E_EMBED_POOLING="${EMBED_POOLING:-}"

CONF="$ROOT/stack.config"
if [ -f "$CONF" ]; then
  set +u
  # shellcheck source=/dev/null
  . "$CONF"
  set -u
fi

EMBED_MODEL="${E_EMBED_MODEL:-${EMBED_MODEL:-}}"
EMBED_FILE="${E_EMBED_FILE:-${EMBED_FILE:-}}"
EMBED_DIM="${E_EMBED_DIM:-${EMBED_DIM:-}}"
EMBED_POOLING="${E_EMBED_POOLING:-${EMBED_POOLING:-}}"

# ---------- модель эмбеддингов ----------
EMBED_AUTO=0
resolve_embed() {
  local m="$EMBED_MODEL" f="$EMBED_FILE" d="$EMBED_DIM" p="$EMBED_POOLING"

  if [ -z "$m" ]; then
    # не задан в stack.config → определяем по тому, что реально лежит в models/
    if [ -n "$f" ]; then
      case "$f" in *bge-m3*) m="bge-m3" ;; *) m="minilm" ;; esac
    elif [ -f "$ROOT/models/bge-m3-q8_0.gguf" ]; then
      m="bge-m3"
    elif [ -f "$ROOT/models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf" ]; then
      m="minilm"
    else
      m="bge-m3"   # дефолт контракта: качественнее
    fi
    EMBED_AUTO=1
  fi

  case "$m" in
    bge-m3)
      [ -n "$f" ] || f="models/bge-m3-q8_0.gguf"
      [ -n "$d" ] || d="1024"
      [ -n "$p" ] || p="cls"
      ;;
    minilm)
      [ -n "$f" ] || f="models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf"
      [ -n "$d" ] || d="384"
      [ -n "$p" ] || p="mean"
      ;;
    *)
      echo "[warn] неизвестная EMBED_MODEL='$m' — беру настройки minilm" >&2
      m="minilm"
      [ -n "$f" ] || f="models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf"
      [ -n "$d" ] || d="384"
      [ -n "$p" ] || p="mean"
      ;;
  esac

  EMBED_MODEL="$m"; EMBED_FILE="$f"; EMBED_DIM="$d"; EMBED_POOLING="$p"
}

# ---------- бинарь llama.cpp ----------
# Ищем: llama.cpp-bin/llama-server, затем llama.cpp-bin/*/llama-server.
# Библиотеки (.so) могут лежать рядом, а могут — в подкаталоге версии
# (llama.cpp-bin/llama-bNNNN/) — отсюда отдельный поиск каталога с .so.
# Кандидат проверяем запуском --version: битая копия (без .so рядом)
# просто пропускается, следующий кандидат wins.
LLAMA_BIN=""
LLAMA_LIB_DIR=""
LLAMA_BACKEND_DIR=""
find_llama_server() {
  local cands=() f d so lib saved_ld
  if [ -x "$ROOT/llama.cpp-bin/llama-server" ]; then
    cands+=("$ROOT/llama.cpp-bin/llama-server")
  fi
  for f in "$ROOT"/llama.cpp-bin/*/llama-server; do
    if [ -x "$f" ]; then cands+=("$f"); fi
  done
  [ ${#cands[@]} -gt 0 ] || return 1

  saved_ld="${LD_LIBRARY_PATH:-}"
  for f in "${cands[@]}"; do
    d="$(dirname "$f")"
    lib="$d"
    if ! ls "$d"/libllama*.so >/dev/null 2>&1 && ! ls "$d"/libggml*.so >/dev/null 2>&1; then
      for so in "$ROOT"/llama.cpp-bin/*/libllama-server-impl.so "$ROOT"/llama.cpp-bin/*/libggml.so.0; do
        if [ -e "$so" ]; then lib="$(dirname "$so")"; break; fi
      done
    fi
    export LD_LIBRARY_PATH="$lib${saved_ld:+:$saved_ld}"
    if "$f" --version >/dev/null 2>&1; then
      LLAMA_BIN="$f"; LLAMA_LIB_DIR="$lib"; break
    fi
  done
  [ -n "$LLAMA_BIN" ] || { export LD_LIBRARY_PATH="$saved_ld"; return 1; }

  # каталог с ggml-бэкендами (без него prebuilt-сборка не стартует:
  # "no backends are loaded")
  LLAMA_BACKEND_DIR="$LLAMA_LIB_DIR"
  if ! ls "$LLAMA_BACKEND_DIR"/libggml*.so >/dev/null 2>&1; then
    for so in "$ROOT"/llama.cpp-bin/*/libggml-cpu-*.so; do
      if [ -e "$so" ]; then LLAMA_BACKEND_DIR="$(dirname "$so")"; break; fi
    done
  fi
  return 0
}

resolve_embed
if find_llama_server; then
  # prebuilt-сборка требует путь к библиотекам и к бэкендам ggml
  export LD_LIBRARY_PATH="$LLAMA_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  [ -d "$ROOT/llama.cpp/build/bin" ] && \
    export LD_LIBRARY_PATH="$ROOT/llama.cpp/build/bin:$LD_LIBRARY_PATH"
  export GGML_BACKEND_PATH="$LLAMA_BACKEND_DIR"
else
  echo "[warn] бинарь llama-server не найден (llama.cpp-bin/) — запусти ./setup.sh" >&2
fi

# Обрати внимание: --host 0.0.0.0 — llama должна быть видна из docker-контейнеров
# honcho (через host.docker.internal, см. honcho/docker-compose.override.yml).

start_embed() {
  if curl -s --max-time 2 http://127.0.0.1:8095/health >/dev/null 2>&1; then
    echo "embed уже работает (:8095)"; return
  fi
  if [ -z "$LLAMA_BIN" ]; then
    echo "[fail] нет llama-server — запусти ./setup.sh"; exit 1
  fi
  if [ ! -f "$ROOT/$EMBED_FILE" ] && [ ! -f "$EMBED_FILE" ]; then
    echo "[fail] нет модели эмбеддингов: $EMBED_FILE"
    echo "       скачать: ./setup.sh --embed-model $EMBED_MODEL   (или make models)"
    exit 1
  fi
  if [ "$EMBED_AUTO" = "1" ]; then
    echo "[info] EMBED_MODEL не задан в stack.config — выбран $EMBED_MODEL (по файлам в models/)"
  fi
  echo "старт embed ($EMBED_MODEL, ${EMBED_DIM}-dim, pooling $EMBED_POOLING, :8095, тихий режим)..."
  mkdir -p "$ROOT/rag"
  # тихий режим: nice +threads 2 — сильной нагрузки на слабом CPU нет
  setsid nice -n 10 "$LLAMA_BIN" -m "$EMBED_FILE" --embedding --pooling "$EMBED_POOLING" \
    --host 0.0.0.0 --port 8095 -c 4096 -b 2048 -ub 2048 --threads "${EMBED_THREADS:-2}" \
    > "$ROOT/rag/embed-server.log" 2>&1 < /dev/null &
  disown
  for i in $(seq 1 30); do
    curl -s --max-time 2 http://127.0.0.1:8095/health >/dev/null 2>&1 && { echo "embed UP"; return; }
    sleep 1
  done
  echo "[warn] embed не поднялся — см. rag/embed-server.log"
}

start_qdrant() {
  if curl -s --max-time 2 http://127.0.0.1:6333/healthz >/dev/null 2>&1; then
    echo "qdrant уже работает (:6333)"; return
  fi
  [ -x ./qdrant/qdrant ] || { echo "[fail] нет qdrant — запусти ./setup.sh"; exit 1; }
  echo "старт Qdrant (:6333)..."
  setsid ./qdrant/qdrant --config-path ./qdrant/config.yaml > qdrant/qdrant.log 2>&1 < /dev/null &
  disown
  for i in $(seq 1 15); do
    curl -s --max-time 2 http://127.0.0.1:6333/healthz >/dev/null 2>&1 && { echo "qdrant UP"; return; }
    sleep 1
  done
  echo "[warn] qdrant не поднялся — см. qdrant/qdrant.log"
}

health() {
  echo "--- статус ---"
  local s ep
  for s in "8095 embed" "6333 qdrant" "8000 honcho"; do
    set -- $s
    ep="health"
    if [ "$1" = "6333" ]; then ep="healthz"; fi
    if curl -sf --max-time 2 "http://127.0.0.1:$1/$ep" >/dev/null 2>&1; then
      echo "  [ok]   :$1 ($2)"
    else
      echo "  [нет]  :$1 ($2)"
    fi
  done
}

show_config() {
  echo "--- параметры стека ---"
  echo "  embed-модель: $EMBED_MODEL"
  echo "  файл:        $EMBED_FILE"
  echo "  размерность: ${EMBED_DIM}-dim"
  echo "  pooling:     $EMBED_POOLING"
  echo "  llama-server: ${LLAMA_BIN:-не найден}"
  echo "  библиотеки:  ${LLAMA_LIB_DIR:-—}"
  echo "  ggml backend: ${LLAMA_BACKEND_DIR:-—}"
  [ -f "$ROOT/$EMBED_FILE" ] && echo "  модель на диске: да" || echo "  модель на диске: НЕТ (нужно ./setup.sh --embed-model $EMBED_MODEL)"
}

case "${1:-all}" in
  embed)  start_embed ;;
  qdrant) start_qdrant ;;
  infra)  start_embed; start_qdrant ;;   # синоним all (инфраструктура без LLM)
  all)    start_embed; start_qdrant ;;
  config) show_config ;;
  stop)
    pkill -f "llama-server" 2>/dev/null || true
    pkill -f "qdrant --config-path" 2>/dev/null || true
    echo "llama-server + qdrant остановлены (honcho в docker не трогаем)" ;;
  health) health ;;
  *) echo "usage: $0 [all|infra|embed|qdrant|config|stop|health]"; exit 1 ;;
esac
