#!/usr/bin/env bash
# ============================================================
# opencode-env / setup.sh — bootstrap окружения после переустановки ОС.
#
# Что ставит (каждый шаг идемпотентен, можно перезапускать):
#   1) npm-зависимости MCP-серверов (mcp/)
#   2) llama.cpp — prebuilt с GitHub Releases; fallback: сборка из исходников (CPU-only)
#   3) embed-модель (bge-m3 или minilm) в models/
#   4) Qdrant — векторная БД RAG
#   5) chromium для Playwright-MCP
#   6) симлинки скиллов (auto-tz, subagent-orchestrator, browser-automation)
#   7) симлинк глобальной команды rag (~/.local/bin/rag)
#   8) honcho (docker) — по --honcho 1
#   9) конфиг opencode (configure.sh) + health-отчёт
#
# Локальной LLM в проекте больше нет: стек даёт только эмбеддинги (RAG)
# и память (honcho). Модель для агентов выбирается в opencode (/models).
#
# Usage:
#   ./setup.sh [--embed-model bge-m3|minilm] [--honcho 0|1] [--config-only]
#              [--skip-llamacpp] [--skip-models] [--skip-qdrant] [--skip-honcho]
#              [--skip-npm] [--skip-playwright] [--force-llamacpp]
#
# Дополнительно (расширения сверх контракта):
#   --only-links   — только симлинки (скиллы + rag), без установки пакетов
#   --skip-config  — не запускать configure.sh
#
# Переменные окружения:
#   EMBED_MODEL           bge-m3 (по умолчанию) | minilm
#   WITH_HONCHO           1 — развернуть honcho в docker
#   LLAMACPP_TAG          тег prebuilt-сборки llama.cpp (по умолчанию b12182)
#   QDRANT_VER            версия Qdrant (по умолчанию 1.19.1)
#   UPDATE_STACK_CONFIG   0 — не трогать ключи EMBED_* в stack.config
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

# ---------- параметры ----------
EMBED_MODEL="${EMBED_MODEL:-}"           # bge-m3 | minilm (пусто = взять из stack.config)
WITH_HONCHO="${WITH_HONCHO:-0}"         # 0 | 1
LLAMACPP_TAG="${LLAMACPP_TAG:-b12182}"  # prebuilt-сборка llama.cpp
QDRANT_VER="${QDRANT_VER:-1.19.1}"      # релиз Qdrant
UPDATE_STACK_CONFIG="${UPDATE_STACK_CONFIG:-1}"

DO_CONFIG_ONLY=0
ONLY_LINKS=0
FORCE_LLAMACPP=0
SKIP_LLAMACPP=0
SKIP_MODELS=0
SKIP_QDRANT=0
SKIP_HONCHO=0
SKIP_NPM=0
SKIP_PLAYWRIGHT=0
SKIP_CONFIG=0

usage() {
  cat <<'EOF'
Использование: ./setup.sh [опции]

Опции:
  --embed-model bge-m3|minilm   какая векторная модель используется (по умолчанию bge-m3)
  --honcho 0|1                  развернуть память honcho в docker (по умолчанию 0)
  --config-only                 только обновить конфиги (opencode.json, honcho/.env, stack.config)
  --only-links                  только симлинки: скиллы + ~/.local/bin/rag
  --force-llamacpp              переустановить llama.cpp (заново скачать prebuilt)
  --skip-llamacpp               не ставить llama.cpp
  --skip-models                 не качать embed-модель
  --skip-qdrant                 не ставить Qdrant
  --skip-honcho                 не разворачивать honcho
  --skip-npm                    не ставить npm-зависимости MCP
  --skip-playwright             не ставить chromium для Playwright
  --skip-config                 не запускать configure.sh
  -h, --help                    эта справка

Переменные окружения:
  EMBED_MODEL, WITH_HONCHO, LLAMACPP_TAG, QDRANT_VER, UPDATE_STACK_CONFIG

Примеры:
  ./setup.sh                                  # базовая установка (bge-m3)
  ./setup.sh --embed-model minilm             # лёгкий вариант (384-dim, 126 МБ)
  ./setup.sh --honcho 1 --embed-model minilm   # базовая установка + память honcho
  ./setup.sh --config-only                    # только перегенерация конфигов
EOF
}

# ---------- разбор флагов ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --embed-model)   [ $# -ge 2 ] || { echo "нужен аргумент: --embed-model bge-m3|minilm"; exit 1; }
                     EMBED_MODEL="$2"; shift 2 ;;
    --embed-model=*) EMBED_MODEL="${1#*=}"; shift ;;
    --honcho)        [ $# -ge 2 ] || { echo "нужен аргумент: --honcho 0|1"; exit 1; }
                     WITH_HONCHO="$2"; shift 2 ;;
    --honcho=*)      WITH_HONCHO="${1#*=}"; shift ;;
    --config-only)   DO_CONFIG_ONLY=1; shift ;;
    --only-links)    ONLY_LINKS=1; shift ;;
    --force-llamacpp) FORCE_LLAMACPP=1; shift ;;
    --skip-llamacpp) SKIP_LLAMACPP=1; shift ;;
    --skip-models)   SKIP_MODELS=1; shift ;;
    --skip-qdrant)   SKIP_QDRANT=1; shift ;;
    --skip-honcho)   SKIP_HONCHO=1; shift ;;
    --skip-npm)      SKIP_NPM=1; shift ;;
    --skip-playwright) SKIP_PLAYWRIGHT=1; shift ;;
    --skip-config)   SKIP_CONFIG=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "неизвестный флаг: $1"; echo; usage; exit 1 ;;
  esac
done

# ---------- цвета и логи ----------
if [ -t 1 ]; then
  C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_0="\033[0m"
else
  C_G=""; C_Y=""; C_R=""; C_0=""
fi
ok()   { echo -e "${C_G}[ ok ]${C_0} $*"; }
warn() { echo -e "${C_Y}[warn]${C_0} $*"; }
fail() { echo -e "${C_R}[fail]${C_0} $*"; }
need() { command -v "$1" >/dev/null 2>&1 || { fail "не найден $1 — установи и повтори"; exit 1; }; }

# значение из stack.config (последнее присваивание, как при source)
config_value() {
  local key="$1" file="$ROOT/stack.config" val=""
  [ -f "$file" ] || return 0
  val="$(sed -n "s/^[[:space:]]*${key}=//p" "$file" | tail -1)"
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

# ---------- контракт embed-модели (см. stack.config / stack.config.example) ----------
# модель не задана флагом/переменной → берём из stack.config, иначе bge-m3
if [ -z "$EMBED_MODEL" ]; then
  EMBED_MODEL="$(config_value EMBED_MODEL)"
  [ -n "$EMBED_MODEL" ] || EMBED_MODEL="bge-m3"
fi
case "$EMBED_MODEL" in
  bge-m3)
    EMBED_FILE="models/bge-m3-q8_0.gguf"
    EMBED_DIM="1024"
    EMBED_POOLING="cls"
    EMBED_URL="https://huggingface.co/vonjack/bge-m3-gguf/resolve/main/bge-m3-q8_0.gguf" ;;
  minilm)
    EMBED_FILE="models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf"
    EMBED_DIM="384"
    EMBED_POOLING="mean"
    EMBED_URL="https://huggingface.co/mykor/paraphrase-multilingual-MiniLM-L12-v2.gguf/resolve/main/paraphrase-multilingual-MiniLM-L12-118M-v2-Q8_0.gguf" ;;
  *)
    fail "неизвестная модель эмбеддингов: $EMBED_MODEL (доступно: bge-m3, minilm)"
    exit 1 ;;
esac

# ============================================================
# 1. Preflight — проверка инструментов
# ============================================================
preflight() {
  need node
  need python3
  need curl
  need git

  local nv major
  nv="$(node -v 2>/dev/null || echo 'v0.0.0')"
  major="${nv#v}"; major="${major%%.*}"
  case "$major" in
    ''|*[!0-9]*) fail "не удалось определить версию node ($nv)"; exit 1 ;;
  esac
  [ "$major" -ge 20 ] || { fail "нужен node >= 20 (сейчас $nv)"; exit 1; }
  ok "node $nv, python3 $(python3 -V 2>&1 | awk '{print $2}'), curl, git"

  # docker нужен только для honcho
  if [ "$WITH_HONCHO" = "1" ] && [ "$SKIP_HONCHO" != "1" ]; then
    command -v docker >/dev/null 2>&1 || { fail "для honcho нужен docker (https://docs.docker.com/engine/install/)"; exit 1; }
    ok "docker $(docker --version 2>/dev/null | head -1)"
  else
    warn "docker не проверяю — он нужен только для honcho (--honcho 1)"
  fi
}

# ============================================================
# 2. npm-зависимости MCP-серверов (mcp/)
# ============================================================
setup_npm() {
  if [ "$SKIP_NPM" = "1" ]; then warn "npm: пропущен (--skip-npm)"; return 0; fi
  [ -f "$ROOT/mcp/package.json" ] || { warn "mcp/package.json не найден — пропускаю npm"; return 0; }

  local need_install=0
  if [ ! -d "$ROOT/mcp/node_modules" ]; then
    need_install=1
  elif [ "$ROOT/mcp/package-lock.json" -nt "$ROOT/mcp/node_modules/.package-lock.json" ] 2>/dev/null; then
    need_install=1
  fi

  if [ "$need_install" = "0" ]; then
    ok "npm: зависимости MCP уже установлены (mcp/node_modules)"
  else
    echo "ставлю npm-зависимости MCP (npm ci в mcp/)..."
    if (cd "$ROOT/mcp" && npm ci --no-audit --no-fund); then
      ok "npm-зависимости MCP установлены"
    else
      warn "npm ci не отработал — пробую npm install"
      if ! (cd "$ROOT/mcp" && npm install --no-audit --no-fund); then
        fail "не удалось поставить npm-зависимости — MCP-серверы работать не будут"
        return 1
      fi
      ok "npm-зависимости MCP установлены (npm install)"
    fi
  fi

  # vision-зависимости (mcp/vision-server.mjs) — предупреждаем, если их нет
  local p
  for p in sharp tesseract.js; do
    if [ -d "$ROOT/mcp/node_modules/$p" ]; then
      ok "mcp/$p на месте"
    else
      warn "mcp/$p нет — vision-MCP (image_info/ocr_image) будет работать ограниченно"
    fi
  done
}

# ============================================================
# 3. llama.cpp (llama-server нужен для эмбеддингов)
# ============================================================
find_llama_server() {
  # Рабочий бинарь: сначала каталоги вида llama.cpp-bin/<tag>/ (там же .so),
  # потом плоская раскладка llama.cpp-bin/llama-server.
  local c
  for c in "$ROOT"/llama.cpp-bin/*/llama-server "$ROOT/llama.cpp-bin/llama-server"; do
    [ -x "$c" ] || continue
    if llama_works "$c"; then echo "$c"; return 0; fi
  done
  return 1
}

find_broken_llama_server() {
  # бинарь есть, но не запускается (например, рядом нет .so)
  local c
  for c in "$ROOT"/llama.cpp-bin/*/llama-server "$ROOT/llama.cpp-bin/llama-server"; do
    [ -x "$c" ] || continue
    llama_works "$c" || { echo "$c"; return 0; }
  done
  return 1
}

llama_works() {
  # бинарь запускается? (проверяем, что рядом нашлись .so)
  "$1" --version >/dev/null 2>&1
}

setup_llamacpp() {
  if [ "$SKIP_LLAMACPP" = "1" ]; then warn "llama.cpp: пропущен (--skip-llamacpp)"; return 0; fi

  if [ "$FORCE_LLAMACPP" = "1" ]; then
    warn "llama.cpp: --force-llamacpp — переустанавливаю бинарь (${LLAMACPP_TAG})"
    rm -rf "$ROOT/llama.cpp-bin"
  fi

  local bin
  if bin="$(find_llama_server)"; then
    ok "llama-server уже есть: ${bin#"$ROOT"/}"
    # плоская копия без .so рядом ломает авто-поиск бинаря — убираем
    local flat="$ROOT/llama.cpp-bin/llama-server"
    if [ "$flat" != "$bin" ] && [ -x "$flat" ] && ! llama_works "$flat"; then
      rm -f "$flat"
      warn "удалена битая копия llama.cpp-bin/llama-server (была без .so рядом)"
    fi
    return 0
  fi

  # бинарь есть, но не запускается — чиним (это bootstrap после переустановки ОС)
  local broken
  if broken="$(find_broken_llama_server)"; then
    warn "llama-server найден, но не запускается: ${broken#"$ROOT"/} — переустанавливаю"
    if [ "${broken#"$ROOT"/}" = "llama.cpp-bin/llama-server" ] && find_llama_server >/dev/null; then
      rm -f "$broken"
      ok "удалена битая плоская копия llama.cpp-bin/llama-server"
      return 0
    fi
  fi

  if install_llamacpp_prebuilt; then return 0; fi
  warn "prebuilt не удался — собираю llama.cpp из исходников (CPU-only)"
  build_llamacpp
}

install_llamacpp_prebuilt() {
  local arch
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) warn "prebuilt llama.cpp нет для архитектуры $(uname -m)"; return 1 ;;
  esac

  local url="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMACPP_TAG}/llama-${LLAMACPP_TAG}-bin-ubuntu-${arch}.tar.gz"
  local tmp="$ROOT/llama.cpp-bin/.llama-${LLAMACPP_TAG}-${arch}.tar.gz"
  mkdir -p "$ROOT/llama.cpp-bin"

  echo "качаю llama.cpp ${LLAMACPP_TAG} (prebuilt, ubuntu-${arch}, ~22 МБ)..."
  if ! curl -fL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
    warn "не удалось скачать prebuilt: $url"
    rm -f "$tmp"; return 1
  fi
  if ! tar xzf "$tmp" -C "$ROOT/llama.cpp-bin"; then
    warn "не удалось распаковать prebuilt"
    rm -f "$tmp"; return 1
  fi
  rm -f "$tmp"
  chmod +x "$ROOT/llama.cpp-bin/llama-${LLAMACPP_TAG}"/* 2>/dev/null || true

  local bin
  if bin="$(find_llama_server)"; then
    ok "llama.cpp ${LLAMACPP_TAG} (prebuilt) готов: ${bin#"$ROOT"/}"
    return 0
  fi
  warn "в архиве нет llama-server"
  return 1
}

build_llamacpp() {
  command -v cmake >/dev/null 2>&1 || { fail "нужен cmake (apt install cmake build-essential)"; exit 1; }
  command -v g++   >/dev/null 2>&1 || { fail "нужен g++ (apt install build-essential)"; exit 1; }

  local SRC="$ROOT/llama.cpp"
  if [ ! -d "$SRC/.git" ]; then
    echo "клонирую исходники llama.cpp (${LLAMACPP_TAG})..."
    git clone --depth 1 --branch "$LLAMACPP_TAG" \
      "https://github.com/ggml-org/llama.cpp.git" "$SRC" \
      || { fail "не удалось клонировать llama.cpp"; exit 1; }
  else
    ok "исходники llama.cpp уже на месте: llama.cpp/"
  fi

  echo "собираю llama.cpp (CPU-only, Release)..."
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >/dev/null \
    || { fail "cmake не отработал — смотри лог сборки"; exit 1; }
  cmake --build "$SRC/build" --target llama-server -j"$(nproc 2>/dev/null || echo 2)" >/dev/null \
    || { fail "сборка llama.cpp не удалась — смотри лог сборки"; exit 1; }

  local dest="$ROOT/llama.cpp-bin/llama-${LLAMACPP_TAG}"
  mkdir -p "$dest"
  cp -f "$SRC/build/bin/llama-server" "$dest/" 2>/dev/null || cp -f "$SRC/build/src/llama-server" "$dest/" 2>/dev/null || true
  cp -f "$SRC/build/bin/"libggml*.so*  "$dest/" 2>/dev/null || true
  cp -f "$SRC/build/bin/"libllama*.so* "$dest/" 2>/dev/null || true
  [ -x "$dest/llama-server" ] || { fail "сборка не дала бинарь — смотри лог сборки"; exit 1; }
  ok "llama-server собран: llama.cpp-bin/llama-${LLAMACPP_TAG}/llama-server"
}

# ============================================================
# 4. Embed-модель (RAG): bge-m3 (1024-dim) или minilm (384-dim)
# ============================================================
http_size() {
  # размер файла по HTTP HEAD (с редиректами) — для проверки целостности
  # (tolower вместо IGNORECASE — работает и на mawk)
  curl -fsIL --max-time 30 "$1" 2>/dev/null \
    | awk 'tolower($0) ~ /^content-length:/ {n=$2} END{gsub(/\r/,"",n); if (n+0>0) print n+0}'
}

download_models() {
  if [ "$SKIP_MODELS" = "1" ]; then warn "модели: пропущены (--skip-models)"; return 0; fi
  mkdir -p "$ROOT/models"

  local dest="$ROOT/$EMBED_FILE"
  local name; name="$(basename "$EMBED_FILE")"
  local want; want="$(http_size "$EMBED_URL" || true)"

  if [ -f "$dest" ] && [ -s "$dest" ]; then
    local have; have="$(stat -c %s "$dest" 2>/dev/null || echo 0)"
    local magic; magic="$(head -c 4 "$dest" 2>/dev/null || true)"
    if [ "$magic" != "GGUF" ]; then
      warn "$name повреждён (не GGUF) — перекачаю"
      rm -f "$dest"
    elif [ -n "$want" ] && [ "$want" -gt 0 ] && [ "$have" -lt $(( want * 90 / 100 )) ]; then
      warn "$name недокачан ($have из $want байт) — перекачаю"
      rm -f "$dest"
    else
      ok "$name уже есть ($(du -h "$dest" | cut -f1))"
      return 0
    fi
  fi

  echo "качаю $name ($EMBED_MODEL, $EMBED_DIM-dim, pooling=$EMBED_POOLING)..."
  curl -fL --retry 3 --retry-delay 2 -C - -o "$dest" "$EMBED_URL" \
    || { fail "не удалось скачать модель: $EMBED_URL"; exit 1; }
  ok "готово: $name ($(du -h "$dest" | cut -f1))"
}

# ============================================================
# 5. Qdrant — векторная БД RAG
# ============================================================
setup_qdrant() {
  if [ "$SKIP_QDRANT" = "1" ]; then warn "qdrant: пропущен (--skip-qdrant)"; return 0; fi
  mkdir -p "$ROOT/qdrant"

  if [ ! -x "$ROOT/qdrant/qdrant" ]; then
    local arch
    case "$(uname -m)" in
      x86_64)          arch=x86_64-unknown-linux-gnu ;;
      aarch64|arm64)   arch=aarch64-unknown-linux-gnu ;;
      *) fail "архитектура $(uname -m) не поддерживается qdrant"; exit 1 ;;
    esac
    local tmp; tmp="$(mktemp -t qdrant.XXXXXX.tar.gz)"
    echo "качаю Qdrant ${QDRANT_VER} (${arch})..."
    if ! curl -fL --retry 3 -o "$tmp" \
      "https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VER}/qdrant-${arch}.tar.gz"; then
      rm -f "$tmp"; fail "не удалось скачать Qdrant"; exit 1
    fi
    tar xzf "$tmp" -C "$ROOT/qdrant/" || { rm -f "$tmp"; fail "qdrant не распаковался"; exit 1; }
    rm -f "$tmp"
    chmod +x "$ROOT/qdrant/qdrant" 2>/dev/null || true
  fi

  [ -x "$ROOT/qdrant/qdrant" ] || { fail "qdrant не распаковался"; exit 1; }
  ok "Qdrant ${QDRANT_VER} готов (qdrant/qdrant)"
}

# ============================================================
# 6. Playwright — chromium для MCP playwright
# ============================================================
setup_playwright() {
  if [ "$SKIP_PLAYWRIGHT" = "1" ]; then warn "playwright: пропущен (--skip-playwright)"; return 0; fi
  local cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  if [ -d "$cache" ] && [ -n "$(ls -A "$cache" 2>/dev/null)" ]; then
    ok "playwright: браузеры уже есть ($cache)"
    return 0
  fi
  command -v npx >/dev/null 2>&1 || { warn "npx не найден — chromium для playwright не поставлен (нужен node.js)"; return 0; }
  echo "ставлю chromium для playwright (~150 МБ)..."
  if npx -y playwright install chromium; then
    ok "playwright chromium готов ($cache)"
  else
    warn "не удалось поставить chromium — MCP playwright будет без браузера"
  fi
}

# ============================================================
# 7. Chrome — нужен для MCP chrome-devtools (предупреждение, без sudo)
# ============================================================
check_chrome() {
  local chrome="${CHROME_PATH:-}"
  [ -n "$chrome" ] || chrome="$(config_value CHROME_PATH)"
  [ -n "$chrome" ] || chrome="/usr/bin/google-chrome"
  if [ -x "$chrome" ]; then
    ok "Chrome найден: $chrome"
    return 0
  fi
  local alt
  for alt in /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do
    if [ -x "$alt" ]; then
      warn "Chrome по пути $chrome не найден, но есть $alt — укажи CHROME_PATH в stack.config"
      return 0
    fi
  done
  warn "Chrome не найден ($chrome) — MCP chrome-devtools работать не будет."
  warn "  Установи Google Chrome вручную (этот скрипт ничего не ставит через sudo)"
  warn "  и пропиши путь в stack.config: CHROME_PATH=/usr/bin/google-chrome"
}

# ============================================================
# 8. Симлинки: скиллы opencode + глобальная команда rag
# ============================================================
install_skills() {
  local dst_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/skills"
  mkdir -p "$dst_dir"
  local s src dst tgt
  for s in auto-tz subagent-orchestrator browser-automation; do
    src="$ROOT/skills/$s"
    dst="$dst_dir/$s"
    if [ ! -d "$src" ]; then
      warn "скилл $s не найден в репо — пропускаю"
      continue
    fi
    if [ -L "$dst" ]; then
      tgt="$(readlink -f "$dst" 2>/dev/null || true)"
      if [ "$tgt" = "$(readlink -f "$src")" ] && [ -d "$dst" ]; then
        ok "скилл $s уже связан"
        continue
      fi
      rm -f "$dst"
      ln -sfn "$src" "$dst"
      ok "скилл $s: ссылка переустановлена → $src"
    elif [ -e "$dst" ]; then
      warn "$dst существует и это не симлинк — не трогаю (удали вручную, если не нужен)"
    else
      ln -sfn "$src" "$dst"
      ok "скилл $s → $src"
    fi
  done
}

install_rag_bin() {
  local dst_dir="$HOME/.local/bin"
  mkdir -p "$dst_dir"
  local src="$ROOT/bin/rag" dst="$dst_dir/rag" tgt
  [ -f "$src" ] || { warn "bin/rag не найден в репо — пропускаю"; return 0; }
  chmod +x "$src" 2>/dev/null || true
  if [ -L "$dst" ]; then
    tgt="$(readlink -f "$dst" 2>/dev/null || true)"
    if [ "$tgt" = "$(readlink -f "$src")" ] && [ -x "$dst" ]; then
      ok "rag уже установлен: $dst"
      return 0
    fi
    rm -f "$dst"
    ln -sfn "$src" "$dst"
    ok "rag: ссылка переустановлена → $src"
  elif [ -e "$dst" ]; then
    warn "$dst существует и это не симлинк — не трогаю"
  else
    ln -sfn "$src" "$dst"
    ok "rag установлен: $dst"
  fi
}

install_links() {
  install_skills
  install_rag_bin
}

# ============================================================
# 9. stack.config — обновляем ТОЛЬКО ключи EMBED_*
#    (остальные строки, включая секреты, не трогаем)
# ============================================================
apply_embed_config() {
  if [ "$UPDATE_STACK_CONFIG" != "1" ]; then
    warn "stack.config: обновление EMBED_* отключено (UPDATE_STACK_CONFIG=0)"
    return 0
  fi
  local cfg="$ROOT/stack.config"
  if [ ! -f "$cfg" ]; then
    if [ -f "$ROOT/stack.config.example" ]; then
      cp "$ROOT/stack.config.example" "$cfg"
      ok "stack.config создан из stack.config.example"
    else
      : > "$cfg"
      ok "stack.config создан"
    fi
    cp "$cfg" "${TMPDIR:-/tmp}/stack.config.bak.$(date +%s)" 2>/dev/null || true
  fi
  python3 - "$cfg" "$EMBED_MODEL" "$EMBED_FILE" "$EMBED_DIM" "$EMBED_POOLING" "$EMBED_URL" <<'PY'
import sys

path, model, efile, dim, pooling, url = sys.argv[1:7]
values = {
    "EMBED_MODEL": model,
    "EMBED_FILE": efile,
    "EMBED_DIM": dim,
    "EMBED_POOLING": pooling,
    "EMBED_URL": url,
}

try:
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
except FileNotFoundError:
    lines = []

out, seen = [], set()
for line in lines:
    stripped = line.strip()
    key = stripped.split("=", 1)[0].strip() if ("=" in stripped and not stripped.startswith("#")) else None
    if key in values:
        out.append(f"{key}={values[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in values.items():
    if key not in seen:
        out.append(f"{key}={value}")

with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out).rstrip() + "\n")
PY
  ok "stack.config: EMBED_MODEL=$EMBED_MODEL ($EMBED_FILE, ${EMBED_DIM}-dim, pooling=$EMBED_POOLING)"
}

# ============================================================
# 10. honcho — память агента (docker)
# ============================================================
setup_honcho() {
  if [ "$SKIP_HONCHO" = "1" ]; then warn "honcho: пропущен (--skip-honcho)"; return 0; fi
  if [ "$WITH_HONCHO" != "1" ]; then
    warn "honcho не разворачивается (--honcho 1 чтобы включить)"
    return 0
  fi
  command -v docker >/dev/null 2>&1 || { fail "honcho требует docker"; exit 1; }
  [ -x "$ROOT/honcho/setup-honcho.sh" ] || { fail "нет honcho/setup-honcho.sh"; exit 1; }
  "$ROOT/honcho/setup-honcho.sh" || { fail "honcho не поднялся — смотри docker compose logs api"; return 1; }
  ok "honcho работает на :8000"
}

# ============================================================
# 11. Конфиг opencode (opencode.json + honcho/.env + плагины)
# ============================================================
setup_opencode_config() {
  if [ "$SKIP_CONFIG" = "1" ]; then warn "конфиг opencode: пропущен (--skip-config)"; return 0; fi
  [ -x "$ROOT/configure.sh" ] || { warn "нет configure.sh — пропускаю генерацию конфига"; return 0; }
  "$ROOT/configure.sh" || { fail "configure.sh не отработал"; return 1; }
  ok "конфиг opencode обновлён: ${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/opencode.json"
}

# ============================================================
# 12. Health-отчёт
# ============================================================
health_report() {
  echo
  echo "================= СТАТУС СЕРВИСОВ ================="
  check() {
    local u="$1" n="$2"
    if curl -sf --max-time 2 "$u" >/dev/null 2>&1; then ok "$n ($u)"; else warn "$n ($u) — не отвечает"; fi
  }
  check "http://127.0.0.1:8095/health"  "embed ($EMBED_MODEL, :8095)"
  if curl -sf --max-time 2 "http://127.0.0.1:6333/healthz" >/dev/null 2>&1 \
     || curl -sf --max-time 2 "http://127.0.0.1:6333/health" >/dev/null 2>&1; then
    ok "qdrant (:6333)"
  else
    warn "qdrant (:6333) — не отвечает"
  fi
  check "http://127.0.0.1:8000/health"  "honcho (:8000)"
  echo "================= ДАЛЬШЕ ======================="
  echo "  ./start.sh all  — поднять embed + qdrant (или make up — ещё и honcho)"
  echo "  opencode        — агентный клиент (модель выбираешь в /models)"
  echo "  ./configure.sh set-vision <model> <base_url> [key] — включить vision-MCP"
}

# ============================================================
# main
# ============================================================
main() {
  echo "== opencode-env setup =="
  echo "   embed-модель: $EMBED_MODEL ($EMBED_FILE, ${EMBED_DIM}-dim, pooling=$EMBED_POOLING)"
  echo "   honcho: $WITH_HONCHO | llama.cpp: $LLAMACPP_TAG | dir: $ROOT"
  echo

  if [ "$ONLY_LINKS" = "1" ]; then
    install_links
    return 0
  fi

  if [ "$DO_CONFIG_ONLY" = "1" ]; then
    apply_embed_config
    setup_opencode_config
    ok "режим --config-only: конфиги обновлены, установка пакетов пропущена"
    return 0
  fi

  preflight
  setup_npm
  setup_llamacpp
  apply_embed_config
  download_models
  setup_qdrant
  setup_playwright
  check_chrome
  install_links
  # конфиг — до honcho: так свежий honcho/.env попадёт в контейнер при первом развёртывании
  setup_opencode_config
  setup_honcho
  health_report
  ok "Установка завершена. Дальше: make up (или ./start.sh all) и opencode"
}

main
