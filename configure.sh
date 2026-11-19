#!/usr/bin/env bash
# ============================================================
# opencode-env / configure.sh — генератор конфигов.
#
# Читает stack.config (если есть) + окружение, пишет:
#   ~/.config/opencode/opencode.json  — opencode (MCP-серверы)
#   honcho/.env                       — модели honcho (deriver/dialectic/summary)
#
# Модель в конфиг НЕ пишется: она выбирается в opencode прямо в сессии
# (/models) и наследуется суб-агентами. Удалённые провайдеры добавляются
# тоже нативно (opencode /providers, auth login, provider add) — здесь
# они не создаются. Этот скрипт ставит только нашу инфраструктуру:
# MCP-серверы (rag, honcho, браузеры, vision) и конфиг памяти honcho.
#
# Локальной LLM (llama.cpp как чат-сервер) больше нет — провайдер local
# не создаётся. llama.cpp работает только как embed-сервер (:8095).
#
# СЛИЯНИЕ (по умолчанию): существующий opencode.json НЕ перезаписывается —
# читается, и в него добавляются/обновляются только ключи этого репо
# (MCP rag/honcho/браузеры/vision). Чужие MCP, плагины, модель и т.п.
# остаются нетронутыми.
#   --force         — полная перегенерация с нуля (старое поведение)
#   --if-missing    — вообще не трогать существующий конфиг
#
# Usage:
#   ./configure.sh                          слить изменения в существующий конфиг
#   ./configure.sh --dir /path/to/project   сгенерировать opencode.json в проект
#   ./configure.sh --if-missing            не перезаписывать существующий конфиг
#   ./configure.sh --force                  перегенерировать с нуля (затирает чужое!)
#   ./configure.sh set-vision MODEL BASE_URL [API_KEY]   включить vision-MCP
#   ./configure.sh --print                  показать итоговый конфиг
#   ./configure.sh --help                   справка по флагам
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

usage() {
  cat <<'EOF'
usage: ./configure.sh [--force|--if-missing|--dir DIR|--print|set-vision MODEL BASE_URL [API_KEY]]

  --force         полная регенерация opencode.json с нуля (затирает чужое!)
  --if-missing    не трогать существующий конфиг
  --dir DIR       сгенерировать opencode.json в каталоге DIR
  --print         показать итоговый конфиг в stdout (файл не пишется)
  set-vision MODEL BASE_URL [API_KEY]
                  включить vision-MCP (MODEL, BASE_URL, ключ — опционально:
                  если не задан, берётся прежний из stack.config)
  -h, --help      эта справка
EOF
}

# --- флаги ---
TARGET_DIR=""
IF_MISSING=0
FORCE=0
PRINT=0
CMD="gen"
VISION_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET_DIR="$2"; shift 2 ;;
    --if-missing) IF_MISSING=1; shift ;;
    --force) FORCE=1; shift ;;
    --print) PRINT=1; shift ;;
    set-vision) CMD="set-vision"; shift; VISION_ARGS=("$@"); break ;;
    gen) shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done

CONF="$ROOT/stack.config"

# ---------- значения из окружения (приоритетнее stack.config) ----------
E_VISION_MODEL="${VISION_MODEL:-}"
E_VISION_BASE_URL="${VISION_BASE_URL:-}"
E_VISION_API_KEY="${VISION_API_KEY:-}"
E_HONCHO_BASE_URL="${HONCHO_LLM_BASE_URL:-}"
E_HONCHO_MODEL="${HONCHO_LLM_MODEL:-}"
E_HONCHO_KEY="${HONCHO_LLM_API_KEY:-}"
E_EMBED_MODEL="${EMBED_MODEL:-}"
E_EMBED_FILE="${EMBED_FILE:-}"
E_EMBED_DIM="${EMBED_DIM:-}"
E_EMBED_POOLING="${EMBED_POOLING:-}"

if [ -f "$CONF" ]; then
  set +u
  # shellcheck source=/dev/null
  . "$CONF"
  set -u
fi

VISION_MODEL="${E_VISION_MODEL:-${VISION_MODEL:-}}"
VISION_BASE_URL="${E_VISION_BASE_URL:-${VISION_BASE_URL:-}}"
VISION_API_KEY="${E_VISION_API_KEY:-${VISION_API_KEY:-}}"
HONCHO_LLM_BASE_URL="${E_HONCHO_BASE_URL:-${HONCHO_LLM_BASE_URL:-}}"
HONCHO_LLM_MODEL="${E_HONCHO_MODEL:-${HONCHO_LLM_MODEL:-}}"
HONCHO_LLM_API_KEY="${E_HONCHO_KEY:-${HONCHO_LLM_API_KEY:-}}"
EMBED_MODEL="${E_EMBED_MODEL:-${EMBED_MODEL:-}}"
EMBED_FILE="${E_EMBED_FILE:-${EMBED_FILE:-}}"
EMBED_DIM="${E_EMBED_DIM:-${EMBED_DIM:-}}"
EMBED_POOLING="${E_EMBED_POOLING:-${EMBED_POOLING:-}}"

# --- значения по умолчанию (всё опционально) ---
CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome}"
HONCHO_BASE_URL="${HONCHO_BASE_URL:-http://127.0.0.1:8000}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# vision без ключа работать не будет — предупреждаем
if [ -n "$VISION_MODEL" ] && [ -z "$VISION_API_KEY" ]; then
  echo "[warn] vision включён ($VISION_MODEL), но VISION_API_KEY пуст — задай в stack.config или экспортируй в окружении" >&2
fi

# ---------- модель эмбеддингов (единый контракт со start.sh) ----------
# bge-m3 — качественнее (~1.2 ГБ, 1024-dim, pooling cls)
# minilm — для маломощных ПК (126 МБ, 384-dim, pooling mean)
if [ -z "$EMBED_MODEL" ]; then
  if [ -n "$EMBED_FILE" ]; then
    case "$EMBED_FILE" in *bge-m3*) EMBED_MODEL="bge-m3" ;; *) EMBED_MODEL="minilm" ;; esac
  elif [ -f "$ROOT/models/bge-m3-q8_0.gguf" ]; then
    EMBED_MODEL="bge-m3"
  elif [ -f "$ROOT/models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf" ]; then
    EMBED_MODEL="minilm"
  else
    EMBED_MODEL="bge-m3"
  fi
fi

case "$EMBED_MODEL" in
  bge-m3)
    [ -n "$EMBED_FILE" ] || EMBED_FILE="models/bge-m3-q8_0.gguf"
    [ -n "$EMBED_DIM" ] || EMBED_DIM="1024"
    [ -n "$EMBED_POOLING" ] || EMBED_POOLING="cls"
    EMBED_MODEL_NAME="bge-m3"
    EMBED_MAX_INPUT_TOKENS="2048"
    EMBED_MAX_TOKENS_PER_REQUEST="8192"
    ;;
  minilm)
    [ -n "$EMBED_FILE" ] || EMBED_FILE="models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf"
    [ -n "$EMBED_DIM" ] || EMBED_DIM="384"
    [ -n "$EMBED_POOLING" ] || EMBED_POOLING="mean"
    EMBED_MODEL_NAME="paraphrase-multilingual-MiniLM-L12-v2"
    EMBED_MAX_INPUT_TOKENS="512"
    EMBED_MAX_TOKENS_PER_REQUEST="2048"
    ;;
  *)
    echo "[warn] неизвестная EMBED_MODEL='$EMBED_MODEL' — беру настройки minilm" >&2
    EMBED_MODEL="minilm"
    [ -n "$EMBED_FILE" ] || EMBED_FILE="models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf"
    [ -n "$EMBED_DIM" ] || EMBED_DIM="384"
    [ -n "$EMBED_POOLING" ] || EMBED_POOLING="mean"
    EMBED_MODEL_NAME="paraphrase-multilingual-MiniLM-L12-v2"
    EMBED_MAX_INPUT_TOKENS="512"
    EMBED_MAX_TOKENS_PER_REQUEST="2048"
    ;;
esac

# ---------- команда set-vision ----------
if [ "$CMD" = "set-vision" ]; then
  [ ${#VISION_ARGS[@]} -ge 2 ] || { echo "usage: configure.sh set-vision MODEL BASE_URL [API_KEY]"; exit 1; }
  V="${VISION_ARGS[0]}"
  B="${VISION_ARGS[1]}"
  K="${VISION_ARGS[2]:-}"
  # ключ не задан — оставляем прежний (если был), чтобы не стирать его
  if [ -z "$K" ] && [ -f "$CONF" ]; then
    OLD="$(sed -n 's/^VISION_API_KEY=//p' "$CONF" | tail -n1)"
    [ -n "$OLD" ] && K="$OLD"
  fi
  if [ -f "$CONF" ]; then
    sed -i "/^VISION_/d" "$CONF"
  else
    : > "$CONF"
  fi
  printf 'VISION_MODEL=%s\nVISION_BASE_URL=%s\nVISION_API_KEY=%s\n' "$V" "$B" "$K" >> "$CONF"
  echo "[ok] vision включён: $V ($B); ключ: $([ -n "$K" ] && echo "задан" || echo "пусто")"
  exec "$0"
fi

# ---------- выбор цели ----------
if [ "$PRINT" = "1" ]; then OUT=/dev/stdout; else OUT="$CONFIG_DIR/opencode.json"; fi
if [ -n "$TARGET_DIR" ]; then OUT="$TARGET_DIR/opencode.json"; fi
if [ -f "$OUT" ] && [ "$IF_MISSING" = "1" ]; then
  echo "[ok] конфиг уже есть: $OUT (--if-missing) — пропускаю генерацию"
  exit 0
fi
mkdir -p "$(dirname "$OUT")"
if [ -f "$OUT" ] && [ "$PRINT" != "1" ]; then cp "$OUT" "$OUT.bak.$(date +%s)" 2>/dev/null || true; fi

export ROOT VISION_MODEL VISION_BASE_URL VISION_API_KEY CHROME_PATH HONCHO_BASE_URL \
       MERGE_FORCE="$FORCE" OUT

python3 - "$OUT" <<'PY'
import json, os, sys

target = sys.argv[1]
force  = os.environ.get("MERGE_FORCE","0") == "1"

root  = os.environ["ROOT"]
vis_m = os.environ.get("VISION_MODEL","")
vis_b = os.environ.get("VISION_BASE_URL","")
vis_k = os.environ.get("VISION_API_KEY","")
chrome= os.environ.get("CHROME_PATH","/usr/bin/google-chrome")
honcho_b=os.environ.get("HONCHO_BASE_URL","http://127.0.0.1:8000")

# ---------- читаем существующий конфиг (merge), если есть и не --force ----------
cfg = {}
if target != "/dev/stdout" and not force and os.path.exists(target):
    try:
        with open(target) as f: existing = json.load(f)
        if isinstance(existing, dict): cfg = existing
        else: print(f"[warn] {target} — не объект, перегенерирую с нуля")
    except Exception as e:
        print(f"[warn] не могу распарсить {target} ({e}) — перегенерирую с нуля")

was_existing = bool(cfg)
cfg.setdefault("$schema", "https://opencode.ai/config.json")

# Модель в конфиг не пишем: основная — та, что выбрана в сессии (/models).
# Существующий "model" (личный выбор юзера) не трогаем.

# ---------- MCP (добавляем/обновляем ТОЛЬКО свои серверы) ----------
servers_ours = {
  "rag": {"type":"local","command":["node", f"{root}/mcp/rag-server.mjs"], "disabled": False},
  "honcho": {"type":"local",
        "command":["node", f"{root}/mcp/honcho-server.mjs"],
        "environment":{"HONCHO_BASE_URL": honcho_b},
        "disabled": False},
  "chrome-devtools": {"type":"local","command":[
        "npx","-y","chrome-devtools-mcp@latest","--headless","--no-sandbox",
        "--chromeArg=--no-sandbox","--chromeArg=--disable-setuid-sandbox",
        "--chromeArg=--disable-dev-shm-usage","--chromeArg=--disable-gpu",
        "--no-usage-statistics","--no-performance-crux","--isolated",
        "--executable-path", chrome], "disabled": False},
  "playwright": {"type":"local","command":[
        "npx","-y","@playwright/mcp@latest","--headless","--no-sandbox",
        "--browser","chromium","--isolated"], "disabled": False},
}
if vis_m:
    servers_ours["vision"] = {"type":"local",
        "command":["node", f"{root}/mcp/vision-server.mjs"],
        "environment":{"OPENAI_BASE_URL":vis_b,"OPENAI_API_KEY":vis_k,"VISION_MODEL":vis_m},
        "disabled": False}

# Merge: добавляем ТОЛЬКО недостающие серверы. Существующие (V1-плоские или
# V2 servers) по структуре не трогаем — это чужой рабочий конфиг
# (например путь к chrome). Обновляем у НАШИХ серверов только окружение
# (например ключ vision) и флаг disabled.
mcp = cfg.setdefault("mcp", {})
if not isinstance(mcp, dict):
    mcp = {}; cfg["mcp"] = mcp
servers = mcp.get("servers")
if not isinstance(servers, dict):
    servers = {}; mcp["servers"] = servers
added = []
updated = []
for k, v in servers_ours.items():
    already = k in servers or (k in mcp and k != "servers")
    if not already:
        servers[k] = v
        added.append(k)
        continue
    tgt = servers.get(k, mcp.get(k))
    if isinstance(tgt, dict):
        changed = False
        if tgt.get("disabled") != v.get("disabled"):
            tgt["disabled"] = v.get("disabled"); changed = True
        env = v.get("environment")
        if env:
            cur = tgt.get("environment")
            if not isinstance(cur, dict):
                cur = {}; tgt["environment"] = cur
            for ek, ev in env.items():
                if cur.get(ek) != ev:
                    cur[ek] = ev; changed = True
        if changed:
            updated.append(k)
if added:
    print(f"[merge] MCP добавлены: {', '.join(added)}")
if updated:
    print(f"[merge] MCP обновлены: {', '.join(updated)}")
if not added and not updated:
    print("[merge] наши MCP уже есть — ничего не добавлено")

exp = cfg.setdefault("experimental", {})
exp.setdefault("mcp_timeout", 300000)

out = sys.argv[1]
if out != "/dev/stdout":
    with open(out,"w") as f: f.write(json.dumps(cfg, indent=2, ensure_ascii=False)+"\n")
    mode = "слияние с существующим" if was_existing else "генерация с нуля"
    print(f"[ok] opencode config -> {out} ({mode})")
else:
    print(json.dumps(cfg, indent=2, ensure_ascii=False))
PY

# ---------- генерация honcho/.env (конкретные значения, без ${...}) ----------
# LLM памяти honcho — удалённый OpenAI-совместимый endpoint (MiniMax по умолчанию).
# Ключ: HONCHO_LLM_API_KEY из stack.config → honcho/fetch-llm-key.sh → "local".
HONCHO_LLM_BASE_URL="${HONCHO_LLM_BASE_URL:-https://api.minimax.io/v1}"
HONCHO_LLM_MODEL="${HONCHO_LLM_MODEL:-MiniMax-M3}"
if [ -z "$HONCHO_LLM_API_KEY" ] && [ -x "$ROOT/honcho/fetch-llm-key.sh" ]; then
  HONCHO_LLM_API_KEY="$(bash "$ROOT/honcho/fetch-llm-key.sh" 2>/dev/null || true)"
  if [ -n "$HONCHO_LLM_API_KEY" ]; then
    echo "[ok] ключ LLM для honcho взят из базы opencode (cred MiniMax)"
  fi
fi
[ -n "$HONCHO_LLM_API_KEY" ] || HONCHO_LLM_API_KEY="local"

if [ -f "$ROOT/honcho/.env.template" ]; then
  mkdir -p "$ROOT/honcho"
  export HONCHO_ENV_BASE_URL="$HONCHO_LLM_BASE_URL" HONCHO_ENV_MODEL="$HONCHO_LLM_MODEL" \
         HONCHO_ENV_KEY="$HONCHO_LLM_API_KEY" HONCHO_ENV_EMBED_MODEL="$EMBED_MODEL_NAME" \
         HONCHO_ENV_EMBED_DIM="$EMBED_DIM" HONCHO_ENV_EMBED_MAX_INPUT="$EMBED_MAX_INPUT_TOKENS" \
         HONCHO_ENV_EMBED_MAX_REQUEST="$EMBED_MAX_TOKENS_PER_REQUEST" HONCHO_ENV_ROOT="$ROOT"
  python3 - <<'PY'
import os, pathlib

root = pathlib.Path(os.environ["HONCHO_ENV_ROOT"])
tpl  = root / "honcho" / ".env.template"
out  = root / "honcho" / ".env"

text = tpl.read_text(encoding="utf-8")
repl = {
    "__HONCHO_LLM_BASE_URL__":      os.environ["HONCHO_ENV_BASE_URL"],
    "__HONCHO_LLM_MODEL__":         os.environ["HONCHO_ENV_MODEL"],
    "__HONCHO_LLM_API_KEY__":       os.environ["HONCHO_ENV_KEY"],
    "__EMBED_MODEL_NAME__":         os.environ["HONCHO_ENV_EMBED_MODEL"],
    "__EMBED_DIM__":                os.environ["HONCHO_ENV_EMBED_DIM"],
    "__EMBED_MAX_INPUT_TOKENS__":   os.environ["HONCHO_ENV_EMBED_MAX_INPUT"],
    "__EMBED_MAX_TOKENS_PER_REQUEST__": os.environ["HONCHO_ENV_EMBED_MAX_REQUEST"],
    # на случай, если в шаблоне осталась старая форма с ${...}
    "${HONCHO_LLM_BASE_URL}":       os.environ["HONCHO_ENV_BASE_URL"],
    "${HONCHO_LLM_MODEL}":          os.environ["HONCHO_ENV_MODEL"],
}
for k, v in repl.items():
    text = text.replace(k, v)

left = [l for l in text.splitlines() if "${" in l]
if left:
    print("[warn] в honcho/.env остались плейсхолдеры ${...}:")
    for l in left:
        print(f"       {l}")

out.write_text(text, encoding="utf-8")
# в файле лежит API-ключ — права 600
out.chmod(0o600)
print(f"[ok] honcho/.env перегенерирован (LLM: {repl['__HONCHO_LLM_BASE_URL__']} / {repl['__HONCHO_LLM_MODEL__']})")
PY
else
  echo "[warn] нет honcho/.env.template — honcho/.env не обновлён"
fi

# ---------- установка глобальных плагинов (авто-зеркало в honcho / авто-индекс RAG) ----------
# Источник — репо; ставятся в ~/.config/opencode/plugins/ (автодискавери глобальных плагинов).
myplugins=("honcho-sync.ts" "rag-sync.ts" "stats-common.mjs")
mkdir -p "$CONFIG_DIR/plugins"
for pl in "${myplugins[@]}"; do
  src="$ROOT/plugins/$pl"
  if [ -f "$src" ]; then
    if [ -f "$CONFIG_DIR/plugins/$pl" ] && ! diff -q "$src" "$CONFIG_DIR/plugins/$pl" >/dev/null 2>&1; then
      cp "$src" "$CONFIG_DIR/plugins/$pl"
      echo "[ok] плагин $pl обновлён в $CONFIG_DIR/plugins/"
    elif [ ! -f "$CONFIG_DIR/plugins/$pl" ]; then
      cp "$src" "$CONFIG_DIR/plugins/$pl"
      echo "[ok] плагин $pl установлен в $CONFIG_DIR/plugins/"
    else
      echo "[ok] плагин $pl уже установлен (актуальная версия)"
    fi
  fi
done
if [ -f "$CONFIG_DIR/plugins/honcho-sync.ts" ]; then
  echo "  honcho-авто-зеркало: $CONFIG_DIR/plugins/honcho-sync.ts (перезапусти opencode, чтобы плагин загрузился)"
fi
if [ -f "$CONFIG_DIR/plugins/rag-sync.ts" ]; then
  echo "  rag-авто: $CONFIG_DIR/plugins/rag-sync.ts (поиск + переиндексация; перезапусти opencode)"
fi

echo "--- итог ---"
echo "  embed-модель:  $EMBED_MODEL ($EMBED_FILE, ${EMBED_DIM}-dim, pooling: ${EMBED_POOLING:-по модели})"
echo "  honcho LLM:    $HONCHO_LLM_BASE_URL ($HONCHO_LLM_MODEL)"
if [ -n "$VISION_MODEL" ]; then
  echo "  vision (MCP):  $VISION_MODEL (@ $VISION_BASE_URL)"
else
  echo "  vision (MCP):  выключен (configure.sh set-vision ...)"
fi
echo "  модель opencode: не задаётся — выбирай в сессии (/models), суб-агенты наследуют её"
echo
CFG_PATH="${TARGET_DIR:+$TARGET_DIR/opencode.json}"
[ -z "$TARGET_DIR" ] && CFG_PATH="$CONFIG_DIR/opencode.json"
echo "Проверь: opencode → /models (модель сессии), /providers (удалённые — нативно), mcp список."
echo "Конфиг: $( [ "$PRINT" = "1" ] && echo stdout || echo "$CFG_PATH" )"
if [ -n "$CFG_PATH" ] && [ "$PRINT" != "1" ] && [ ! -f "$CFG_PATH" ]; then
  echo "  (opencode.json записан в $CFG_PATH — opencode подхватит его автоматически)"
fi
exit 0
