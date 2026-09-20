#!/usr/bin/env bash
# ============================================================
# opencode-env / configure.sh — генератор конфигов под выбранную модель.
#
# Читает stack.config (если есть) + окружение, пишет:
#   ~/.config/opencode/opencode.json  — opencode (провайдеры/модели/агенты/MCP)
#   honcho/.env                       — модели honcho (deriver/dialectic/summary)
#
# СЛИЯНИЕ (по умолчанию): существующий opencode.json НЕ перезаписывается —
# читается, и в него добавляются/обновляются только ключи этого репо
# (провайдеры local/remote, агенты AGENT_MODEL_*, MCP rag/honcho/браузеры).
# Чужие провайдеры, MCP (qwen-image, wordstat...), плагины, модель и т.п.
# остаются нетронутыми. Сделай бэкап перед полной перегенерацией:
#   --force   — полная перегенерация с нуля (старое поведение)
#   --if-missing — вообще не трогать существующий конфиг
#
# Usage:
#   ./configure.sh                          слить изменения в существующий конфиг
#   ./configure.sh --dir /path/to/project   сгенерировать opencode.json в проект
#   ./configure.sh --if-missing            не перезаписывать существующий конфиг
#   ./configure.sh --force                  перегенерировать с нуля (затирает чужое!)
#   ./configure.sh set-model local|remote MODEL   переключить основную модель
#   ./configure.sh set-vision MODEL BASE_URL [API_KEY]   включить vision
#   ./configure.sh set-agent-model AGENT MODEL   модель конкретного суб-агента
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

# --- значения по умолчанию ---
LOCAL_LLM_BASE_URL="${LOCAL_LLM_BASE_URL:-http://127.0.0.1:1234/v1}"
LOCAL_LLM_MODEL="${LOCAL_LLM_MODEL:-local-coder}"
REMOTE_BASE_URL="${REMOTE_BASE_URL:-}"
REMOTE_API_KEY="${REMOTE_API_KEY:-}"
REMOTE_MODEL="${REMOTE_MODEL:-}"
OPENCODE_MODEL="${OPENCODE_MODEL:-local/coder}"
VISION_MODEL="${VISION_MODEL:-}"
VISION_BASE_URL="${VISION_BASE_URL:-}"
VISION_API_KEY="${VISION_API_KEY:-}"
CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome}"
HONCHO_BASE_URL="${HONCHO_BASE_URL:-http://127.0.0.1:8000}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# Модели суб-агентов (пусто = наследовать модель сессии — главный режим)
AGENT_MODEL_GENERAL="${AGENT_MODEL_GENERAL:-}"
AGENT_MODEL_EXPLORE="${AGENT_MODEL_EXPLORE:-}"
AGENT_MODEL_IMPLEMENTER="${AGENT_MODEL_IMPLEMENTER:-}"
AGENT_MODEL_REVIEWER="${AGENT_MODEL_REVIEWER:-}"

# ---------- команды ----------
case "${1:-gen}" in
  set-model)
    [ $# -ge 3 ] || { echo "usage: configure.sh set-model local|remote MODEL"; exit 1; }
    BACKEND="$2"; M="$3"
    if [ "$BACKEND" = "local" ]; then
      sed -i "s|^OPENCODE_MODEL=.*|OPENCODE_MODEL=local/coder|" "$CONF" 2>/dev/null || echo "OPENCODE_MODEL=local/coder" >> "$CONF"
    else
      sed -i "s|^OPENCODE_MODEL=.*|OPENCODE_MODEL=remote/main|" "$CONF" 2>/dev/null || echo "OPENCODE_MODEL=remote/main" >> "$CONF"
      echo "  (убедись, что в stack.config заданы REMOTE_BASE_URL/REMOTE_API_KEY/REMOTE_MODEL)"
    fi
    echo "основная модель -> $BACKEND ($M)"; exec "$0" ;;
  set-vision)
    [ $# -ge 3 ] || { echo "usage: configure.sh set-vision MODEL BASE_URL [API_KEY]"; exit 1; }
    V="$2"; B="$3"; K="${4:-}"
    sed -i "/^VISION_/d" "$CONF" 2>/dev/null || true
    printf 'VISION_MODEL=%s\nVISION_BASE_URL=%s\nVISION_API_KEY=%s\n' "$V" "$B" "$K" >> "$CONF"
    echo "vision включён: $V"; exec "$0" ;;
  set-agent-model)
    [ $# -ge 3 ] || { echo "usage: configure.sh set-agent-model AGENT MODEL"; exit 1; }
    A="$(echo "$2" | tr '[:lower:]' '[:upper:]')"; M="$3"
    sed -i "/^AGENT_MODEL_${A}=/d" "$CONF" 2>/dev/null || true
    echo "AGENT_MODEL_${A}=$M" >> "$CONF"
    echo "агент $2 -> $M"; exec "$0" ;;
  gen|--print) : ;;
  *) echo "usage: $0 [set-model|set-vision|set-agent-model|gen|--print]"; exit 1 ;;
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

export ROOT LOCAL_LLM_BASE_URL LOCAL_LLM_MODEL REMOTE_BASE_URL REMOTE_API_KEY REMOTE_MODEL \
       OPENCODE_MODEL VISION_MODEL VISION_BASE_URL VISION_API_KEY CHROME_PATH HONCHO_BASE_URL \
       AGENT_MODEL_GENERAL AGENT_MODEL_EXPLORE AGENT_MODEL_IMPLEMENTER AGENT_MODEL_REVIEWER \
       MERGE_FORCE="$FORCE" MERGE_IF_MISSING="$IF_MISSING" OUT

python3 - "$OUT" <<'PY'
import json, os, sys

target = sys.argv[1]
force  = os.environ.get("MERGE_FORCE","0") == "1"

root  = os.environ["ROOT"]
local_b= os.environ["LOCAL_LLM_BASE_URL"]
local_m= os.environ["LOCAL_LLM_MODEL"]
remote_b=os.environ.get("REMOTE_BASE_URL","")
remote_k=os.environ.get("REMOTE_API_KEY","")
remote_m=os.environ.get("REMOTE_MODEL","")
open_model=os.environ.get("OPENCODE_MODEL","local/coder")
vis_m = os.environ.get("VISION_MODEL","")
vis_b = os.environ.get("VISION_BASE_URL","")
vis_k = os.environ.get("VISION_API_KEY","")
chrome= os.environ.get("CHROME_PATH","/usr/bin/google-chrome")
honcho_b=os.environ.get("HONCHO_BASE_URL","http://127.0.0.1:8000")

def am(name):
    v = os.environ.get(f"AGENT_MODEL_{name.upper()}","")
    return v or None

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
# root-модель: не перезаписываем чужой выбор, ставим только если её ещё нет
if open_model and not cfg.get("model") and target != "/dev/stdout":
    cfg["model"] = open_model

# ---------- провайдеры (добавляем/обновляем ТОЛЬКО свои id) ----------
providers = cfg.setdefault("providers", {})
providers["local"] = {
    "name": "Local llama.cpp (:1234)",
    "package": "@opencode/ai/providers/openai-compatible",
    "settings": {"baseURL": local_b, "apiKey": "local"},
    "models": {
        "coder": {
            "modelID": local_m,
            "name": "Gemma 4 12B it (256K)",
            "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
            "limit": {"context": 262144, "output": 65536},
        }
    },
}
if remote_b:
    providers["remote"] = {
        "name": "Remote OpenAI-compatible",
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": remote_b, "apiKey": remote_k or "x"},
        "models": {"main": {"modelID": remote_m or "main", "limit": {"context": 200000, "output": 32768}}},
    }

# ---------- агенты (только заданные AGENT_MODEL_*; остальное не трогаем) ----------
agent_models = {n: am(n) for n in ("general","explore","implementer","reviewer") if am(n)}
if agent_models:
    agents = cfg.setdefault("agents", {})
    for n, m in agent_models.items():
        agents.setdefault(n, {})["model"] = m

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
  HONCHO_B="${HONCHO_LLM_BASE_URL:-${LOCAL_LLM_BASE_URL}}"
  HONCHO_M="${HONCHO_LLM_MODEL:-${LOCAL_LLM_MODEL}}"
  sed -e "s|^HONCHO_LLM_BASE_URL=.*|HONCHO_LLM_BASE_URL=${HONCHO_B}|" \
      -e "s|^HONCHO_LLM_MODEL=.*|HONCHO_LLM_MODEL=${HONCHO_M}|" \
      honcho/.env.template > honcho/.env
  echo "[ok] honcho/.env перегенерирован (LLM: $HONCHO_B / $HONCHO_M)"
fi

echo "--- итог ---"
echo "  основная модель: $OPENCODE_MODEL"
echo "  локальная LLM:   $LOCAL_LLM_BASE_URL ($LOCAL_LLM_MODEL)"
[ -n "$REMOTE_BASE_URL" ] && echo "  удалённая LLM:   $REMOTE_BASE_URL ($REMOTE_MODEL)" || echo "  удалённая LLM:   не настроена (добавь REMOTE_* в stack.config)"
[ -n "$VISION_MODEL" ] && echo "  vision:          $VISION_MODEL (@ $VISION_BASE_URL)" || echo "  vision:          выключен (configure.sh set-vision ...)"
echo
CFG_PATH="${TARGET_DIR:+$TARGET_DIR/opencode.json}"
[ -z "$TARGET_DIR" ] && CFG_PATH="$CONFIG_DIR/opencode.json"
echo "Проверь: opencode → /models (выбор модели в сессии: локальная или удалённая), mcp список."
echo "Конфиг: $( [ "${1:-}" = "--print" ] && echo stdout || echo "$CFG_PATH" )"
[ -n "$CFG_PATH" ] && [ "${1:-}" != "--print" ] && [ ! -f "$CFG_PATH" ] && echo "  (opencode.json записан в $CFG_PATH — opencode подхватит его автоматически)"