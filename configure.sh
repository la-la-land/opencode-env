#!/usr/bin/env bash
# ============================================================
# opencode-env / configure.sh — генератор конфигов.
#
# Читает stack.config (если есть) + окружение, пишет:
#   ~/.config/opencode/opencode.json  — opencode (провайдер local, MCP)
#   honcho/.env                       — модели honcho (deriver/dialectic/summary)
#
# Модель в конфиг НЕ пишется: она выбирается в opencode прямо в сессии
# (/models) и наследуется суб-агентами. Удалённые провайдеры добавляются
# тоже нативно (opencode /providers, auth login, provider add) — здесь
# они не создаются. Этот скрипт ставит только нашу инфраструктуру:
# провайдер local (llama.cpp) и MCP-серверы (rag, honcho, браузеры, vision).
#
# СЛИЯНИЕ (по умолчанию): существующий opencode.json НЕ перезаписывается —
# читается, и в него добавляются/обновляются только ключи этого репо
# (провайдер local, MCP rag/honcho/браузеры). Чужие провайдеры, MCP
# (qwen-image, wordstat...), плагины, модель и т.п. остаются нетронутыми.
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
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

# --- флаги ---
TARGET_DIR=""
IF_MISSING=0
FORCE=0
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET_DIR="$2"; shift 2 ;;
    --if-missing) IF_MISSING=1; shift ;;
    --force) FORCE=1; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done
set -- "${EXTRA[@]}"

CONF="$ROOT/stack.config"
[ -f "$CONF" ] && . "$CONF" || true

# --- значения по умолчанию (всё опционально) ---
LOCAL_LLM_BASE_URL="${LOCAL_LLM_BASE_URL:-http://127.0.0.1:1234/v1}"
LOCAL_LLM_MODEL="${LOCAL_LLM_MODEL:-local-coder}"
VISION_MODEL="${VISION_MODEL:-}"
VISION_BASE_URL="${VISION_BASE_URL:-}"
VISION_API_KEY="${VISION_API_KEY:-}"
CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome}"
HONCHO_BASE_URL="${HONCHO_BASE_URL:-http://127.0.0.1:8000}"
LOCAL_PROVIDER="${LOCAL_PROVIDER:-1}"    # 0 = не добавлять провайдер local (llama.cpp)
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# ---------- команды ----------
case "${1:-gen}" in
  set-vision)
    [ $# -ge 3 ] || { echo "usage: configure.sh set-vision MODEL BASE_URL [API_KEY]"; exit 1; }
    V="$2"; B="$3"; K="${4:-}"
    sed -i "/^VISION_/d" "$CONF" 2>/dev/null || true
    printf 'VISION_MODEL=%s\nVISION_BASE_URL=%s\nVISION_API_KEY=%s\n' "$V" "$B" "$K" >> "$CONF"
    echo "vision включён: $V"; exec "$0" ;;
  gen|--print) : ;;
  *) echo "usage: $0 [set-vision|gen|--print]"; exit 1 ;;
esac

# ---------- выбор цели ----------
[ "${1:-}" = "--print" ] && OUT=/dev/stdout || OUT="$CONFIG_DIR/opencode.json"
if [ -n "$TARGET_DIR" ]; then OUT="$TARGET_DIR/opencode.json"; fi
if [ -f "$OUT" ] && [ "$IF_MISSING" = "1" ]; then
  echo "[ok] конфиг уже есть: $OUT (--if-missing) — пропускаю генерацию"
  exit 0
fi
mkdir -p "$(dirname "$OUT")"
[ -f "$OUT" ] && [ "${1:-}" != "--print" ] && cp "$OUT" "$OUT.bak.$(date +%s)" 2>/dev/null || true

export ROOT LOCAL_LLM_BASE_URL LOCAL_LLM_MODEL VISION_MODEL VISION_BASE_URL VISION_API_KEY \
       CHROME_PATH HONCHO_BASE_URL LOCAL_PROVIDER MERGE_FORCE="$FORCE" OUT

python3 - "$OUT" <<'PY'
import json, os, sys

target = sys.argv[1]
force  = os.environ.get("MERGE_FORCE","0") == "1"

root  = os.environ["ROOT"]
local_b= os.environ["LOCAL_LLM_BASE_URL"]
local_m= os.environ["LOCAL_LLM_MODEL"]
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

cfg.setdefault("$schema", "https://opencode.ai/config.json")
was_existing = bool(cfg)

# Модель в конфиг не пишем: основная — та, что выбрана в сессии (/models).
# Существующий "model" (личный выбор юзера) не трогаем.

# ---------- провайдеры: local (llama.cpp) — только по явному желанию ----------
# LOCAL_PROVIDER=0 (stack.config или env) — не трогаем провайдеры вовсе:
# удалённые добавляются нативно (opencode /providers, auth login, provider add),
# существующие (наш провайдер local или чужой) остаются как есть.
if os.environ.get("LOCAL_PROVIDER", "1") != "0":
    providers = cfg.setdefault("providers", {})
    providers["local"] = {
        "name": "Local llama.cpp (:1234)",
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": local_b, "apiKey": "local"},
        "models": {
            "gemma": {
                "modelID": local_m,
                "name": "Local Gemma 4 12B it (256K)",
                "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                "limit": {"context": 262144, "output": 65536},
            }
        },
    }

# ---------- MCP (добавляем/обновляем ТОЛЬКО свои серверы) ----------
servers_ours = {
  "rag": {"type":"local","command":["node", f"{root}/mcp/rag-server.mjs"], "disabled": True},
  "honcho": {"type":"local",
        "command":["node", f"{root}/mcp/honcho-server.mjs"],
        "environment":{"HONCHO_BASE_URL": honcho_b},
        "disabled": True},
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
# V2 servers) не трогаем — это чужой рабочий конфиг (например путь к chrome).
mcp = cfg.setdefault("mcp", {})
if not isinstance(mcp, dict):
    mcp = {}; cfg["mcp"] = mcp
servers = mcp.get("servers")
if not isinstance(servers, dict):
    servers = {}; mcp["servers"] = servers
added = []
for k, v in servers_ours.items():
    already = k in servers or (k in mcp and k != "servers")
    if not already:
        servers[k] = v
        added.append(k)
if added:
    print(f"[merge] MCP добавлены: {', '.join(added)}")
else:
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

# ---------- генерация honcho/.env (модели) ----------
if [ -f honcho/.env.template ]; then
  mkdir -p honcho
  # honcho всегда в docker — хост (llama.cpp :1234) из контейнера доступен
  # только через host.docker.internal (настраивается в docker-compose.override.yml).
  HONCHO_B="${HONCHO_LLM_BASE_URL:-http://host.docker.internal:1234/v1}"
  HONCHO_M="${HONCHO_LLM_MODEL:-${LOCAL_LLM_MODEL}}"
  sed -e "s|^HONCHO_LLM_BASE_URL=.*|HONCHO_LLM_BASE_URL=${HONCHO_B}|" \
      -e "s|^HONCHO_LLM_MODEL=.*|HONCHO_LLM_MODEL=${HONCHO_M}|" \
      honcho/.env.template > honcho/.env
  echo "[ok] honcho/.env перегенерирован (LLM: $HONCHO_B / $HONCHO_M)"
fi

# ---------- установка глобального плагина honcho-sync (авто-зеркало в honcho) ----------
# Источник — репо; ставится в ~/.config/opencode/plugins/ (автодискавери глобальных плагинов).
myplugins=("honcho-sync.ts" "rag-sync.ts")
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
echo "  локальная LLM:   $LOCAL_LLM_BASE_URL ($LOCAL_LLM_MODEL)"
[ -n "$VISION_MODEL" ] && echo "  vision (MCP):    $VISION_MODEL (@ $VISION_BASE_URL)" || echo "  vision (MCP):    выключен (configure.sh set-vision ...)"
echo "  модель opencode: не задаётся — выбирай в сессии (/models), суб-агенты наследуют её"
echo
CFG_PATH="${TARGET_DIR:+$TARGET_DIR/opencode.json}"
[ -z "$TARGET_DIR" ] && CFG_PATH="$CONFIG_DIR/opencode.json"
echo "Проверь: opencode → /models (модель сессии), /providers (удалённые — нативно), mcp список."
echo "Конфиг: $( [ "${1:-}" = "--print" ] && echo stdout || echo "$CFG_PATH" )"
if [ -n "$CFG_PATH" ] && [ "${1:-}" != "--print" ] && [ ! -f "$CFG_PATH" ]; then
  echo "  (opencode.json записан в $CFG_PATH — opencode подхватит его автоматически)"
fi
exit 0