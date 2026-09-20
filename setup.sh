#!/usr/bin/env bash
# ============================================================
# opencode-env / setup.sh — установка окружения для агентной
# разработки (opencode + локальный стек: llama.cpp, эмбеддинги,
# Qdrant, honcho). Идемпотентен: можно перезапускать.
#
# Usage:
#   ./setup.sh [--model gemma|30b|none] [--backend local|remote]
#              [--honcho 0|1] [--config-only] [--skip-*]
#
# Переменные окружения: MODEL_CHOICE, BACKEND, WITH_HONCHO,
#   LLAMACPP_TAG (тег/коммит llama.cpp для сборки), HONCHO_SRC.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

# ---------- параметры ----------
MODEL_CHOICE="${MODEL_CHOICE:-gemma}"      # gemma | none
BACKEND="${BACKEND:-local}"                # local | remote
WITH_HONCHO="${WITH_HONCHO:-0}"            # 0 | 1
DO_CONFIG_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --model)   MODEL_CHOICE="$2"; shift 2 ;;
    --backend) BACKEND="$2";      shift 2 ;;
    --honcho)  WITH_HONCHO="$2";  shift 2 ;;
    --config-only) DO_CONFIG_ONLY=1; shift ;;
    --skip-llamacpp) SKIP_LLAMACPP=1; shift ;;
    --skip-qdrant)   SKIP_QDRANT=1;   shift ;;
    --skip-honcho)   SKIP_HONCHO=1;   shift ;;
    *) echo "неизвестный флаг: $1"; exit 1 ;;
  esac
done

# ---------- цвета ----------
C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_B="\033[1m"; C_0="\033[0m"
ok()  { echo -e "${C_G}[ ok ]${C_0} $*"; }
warn(){ echo -e "${C_Y}[warn]${C_0} $*"; }
fail(){ echo -e "${C_R}[fail]${C_0} $*"; }

need() { command -v "$1" >/dev/null 2>&1 || { fail "не найден $1 — установи и повтори"; exit 1; }; }
need curl; need git; need python3; need node

# ============================================================
# 1. Детект железа
# ============================================================
detect_gpu() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    GPU="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)"
    VRAM_GB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,units=none 2>/dev/null | head -1 | awk '{printf "%.0f", $1/1024}')"
    ok "GPU: $GPU"
  else
    GPU=""; VRAM_GB=0
    warn "GPU (nvidia) не найдена — будет CPU-режим (медленно) или удалённая модель"
  fi
}

# ============================================================
# 2. CUDA-рантайм через pip (без системного CUDA toolkit)
# ============================================================
install_cuda_pip() {
  if [ "$BACKEND" = "remote" ]; then return 0; fi
  python3 - <<'PY' >/dev/null 2>&1 && return 0
import importlib.util
ok = all(importlib.util.find_spec(m) for m in ["nvidia.cublas","nvidia.cuda_runtime"])
if not ok:
    print("missing")
    exit(1)
PY
  echo "ставим nvidia CUDA runtime (pip, cu13)..."
  python3 -m pip install -q --user \
    nvidia-cuda-runtime-cu13 nvidia-cublas-cu13 nvidia-cudnn-cu13 \
    nvidia-cusparse-cu13 nvidia-cusparselt-cu13 nvidia-cufft-cu13 \
    nvidia-cuda-nvrtc-cu13 nvidia-nvjitlink-cu13 nvidia-nccl-cu13
  ok "CUDA runtime готов (pip)"
}

# ============================================================
# 3. llama.cpp (бинарь llama-server)
# ============================================================
setup_llamacpp() {
  [ "${SKIP_LLAMACPP:-0}" = "1" ] && return 0
  [ "$BACKEND" = "remote" ] && { ok "BACKEND=remote: llama.cpp не нужен для инференса"; return 0; }

  if [ -x "$ROOT/llama.cpp-bin/llama-server" ]; then
    ok "llama.cpp-bin/llama-server уже есть"
    return 0
  fi
  if [ -d "$ROOT/llama.cpp/.git" ]; then
    ok "исходники llama.cpp на месте, собираю..."
    build_llamacpp "$ROOT/llama.cpp"
    return 0
  fi

  REPO="https://github.com/ggml-org/llama.cpp.git"
  TAG="${LLAMACPP_TAG:-master}"
  echo "клонирую llama.cpp (${TAG})..."
  git clone --depth 1 --branch "$TAG" "$REPO" "$ROOT/llama.cpp"
  build_llamacpp "$ROOT/llama.cpp"
}

build_llamacpp() {
  local SRC="$1"
  command -v cmake >/dev/null 2>&1 || { fail "нужен cmake (sudo apt install cmake)"; exit 1; }
  command -v g++ >/dev/null 2>&1 || { fail "нужен g++ (sudo apt install build-essential)"; exit 1; }
  cmake -S "$SRC" -B "$SRC/build" -DGGML_CUDA=ON -DGGML_CUDA_USE_PIP_PACKAGES=ON -DGGML_MTMD=ON -DCMAKE_BUILD_TYPE=Release >/dev/null
  cmake --build "$SRC/build" --target llama-server -j"$(nproc)" >/dev/null
  mkdir -p "$ROOT/llama.cpp-bin"
  cp -f "$SRC/build/bin/llama-server" "$ROOT/llama.cpp-bin/" 2>/dev/null || \
  cp -f "$SRC/build/src/llama-server" "$ROOT/llama.cpp-bin/" 2>/dev/null || true
  # разделяемые библиотеки (ggml-cuda, mtmd и пр.)
  cp -f "$SRC/build/bin/"libggml*.so* "$ROOT/llama.cpp-bin/" 2>/dev/null || true
  cp -f "$SRC/build/bin/"libmtmd*.so* "$ROOT/llama.cpp-bin/" 2>/dev/null || true
  [ -x "$ROOT/llama.cpp-bin/llama-server" ] && ok "llama-server собран" || { fail "сборка не дала бинарь — смотри логи cmake"; exit 1; }
}

# ============================================================
# 4. Модели (скачивание с HuggingFace, докачка при обрыве)
# ============================================================
BGE_URL="https://huggingface.co/vonjack/bge-m3-gguf/resolve/main/bge-m3-q8_0.gguf"
GEMMA_URL="https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q4_K_M.gguf"

dl() { # dl <url> <dest>
  local url="$1" dest="$2"
  if [ -f "$dest" ] && [ -s "$dest" ]; then ok "есть: $(basename "$dest")"; return 0; fi
  echo "качаю: $(basename "$dest")..."
  curl -fL --retry 3 --retry-delay 2 -C - -o "$dest" "$url" >/dev/null || { fail "скачивание не удалось: $url"; exit 1; }
  ok "готово: $(basename "$dest") ($(du -h "$dest" | cut -f1))"
}

download_models() {
  mkdir -p "$ROOT/models"
  dl "$BGE_URL" "$ROOT/models/bge-m3-q8_0.gguf"           # эмбеддинги для RAG (всегда)
  case "$MODEL_CHOICE" in
    gemma) dl "$GEMMA_URL" "$ROOT/models/gemma-4-12b-it-Q4_K_M.gguf" ;;
    none)  warn "модель инференса не качаем (MODEL_CHOICE=none) — используй удалённую или впиши свою" ;;
    *)     fail "неизвестная модель: $MODEL_CHOICE"; exit 1 ;;
  esac
}

# ============================================================
# 5. Qdrant (векторная БД RAG)
# ============================================================
QDRANT_VER="1.19.1"
setup_qdrant() {
  [ "${SKIP_QDRANT:-0}" = "1" ] && return 0
  mkdir -p "$ROOT/qdrant"
  if [ -x "$ROOT/qdrant/qdrant" ]; then ok "qdrant бинарь уже есть"; return 0; fi
  local arch
  case "$(uname -m)" in x86_64) arch=x86_64-unknown-linux-gnu ;; aarch64|arm64) arch=aarch64-unknown-linux-gnu ;; *) fail "архитектура не поддерживается"; exit 1 ;; esac
  echo "качаю Qdrant ${QDRANT_VER} (${arch})..."
  curl -fL --retry 3 -o /tmp/qdrant.tgz \
    "https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VER}/qdrant-${arch}.tar.gz"
  tar xzf /tmp/qdrant.tgz -C "$ROOT/qdrant/"
  chmod +x "$ROOT/qdrant/qdrant" 2>/dev/null || true
  [ -x "$ROOT/qdrant/qdrant" ] && ok "Qdrant ${QDRANT_VER} готов" || { fail "qdrant не распаковался"; exit 1; }
}

# ============================================================
# 6. Honcho (память) — отдельный модуль, см. honcho/
# ============================================================
setup_honcho() {
  [ "${SKIP_HONCHO:-0}" = "1" ] && return 0
  [ "$WITH_HONCHO" = "1" ] || { warn "honcho пропущен (--honcho 1 чтобы развернуть)"; return 0; }
  command -v docker >/dev/null 2>&1 || { fail "honcho требует docker"; exit 1; }
  "$ROOT/honcho/setup-honcho.sh" || { fail "honcho не поднялся"; exit 1; }
  ok "honcho работает на :8000"
}

# ============================================================
# 7. Конфиг opencode (из шаблона)
# ============================================================
setup_opencode_config() {
  local cfgdir="$HOME/.config/opencode"
  local cfg="$cfgdir/opencode.json"
  if [ -f "$cfg" ]; then
    ok "конфиг opencode уже есть: $cfg (шаблон: opencode.json.example)"
    return 0
  fi
  [ "$DO_CONFIG_ONLY" = "1" ] && : # разрешаем генерацию даже в config-only
  if [ "$DO_CONFIG_ONLY" = "1" ] || [ "$BACKEND" = "local" ]; then
    mkdir -p "$cfgdir"
    cp "$ROOT/opencode.json.example" "$cfg"
    warn "создан конфиг из шаблона: $cfg"
    warn "  → замени /PATH/TO/opencode-env на $ROOT"
    warn "  → если используешь chrome-devtools: задай CHROME_PATH (или правь opencode.json)"
  fi
}

# ============================================================
# 8. Отчёт о здоровье
# ============================================================
health_report() {
  echo
  echo "================= СТАТУС СЕРВИСОВ ================="
  check() { local u="$1" n="$2"; if curl -sf --max-time 2 "$u" >/dev/null 2>&1; then ok "$n ($u)"; else warn "$n ($u) — не отвечает"; fi; }
  check http://127.0.0.1:1234/health "LLM :1234"
  check http://127.0.0.1:8095/health "Embed :8095"
  check http://127.0.0.1:6333/health "Qdrant :6333"
  check http://127.0.0.1:8000/health "Honcho :8000"
  echo "================= ДАЛЬШЕ ======================="
  echo "  ./start.sh all    — поднять стек (или make start)"
  echo "  opencode          — запуск агентного клиента (выбор модели: /models)"
  echo "  На сервере без GPU: BACKEND=remote ./setup.sh + настрой remote-провайдера"
}

# ============================================================
main() {
  echo "== opencode-env setup =="
  echo "   model: $MODEL_CHOICE | backend: $BACKEND | honcho: $WITH_HONCHO | dir: $ROOT"
  detect_gpu
  if [ "$DO_CONFIG_ONLY" = "1" ]; then setup_opencode_config; return 0; fi
  install_cuda_pip
  setup_llamacpp
  download_models
  setup_qdrant
  setup_honcho
  setup_opencode_config
  health_report
  ok "Установка завершена. Модели: models/, запуск: ./start.sh all"
}
main