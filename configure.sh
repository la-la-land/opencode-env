#!/usr/bin/env bash
# ============================================================
# opencode-env / configure.sh — генератор конфигов под выбранную модель.
#
# Читает stack.config (если есть) + окружение, пишет:
#   ~/.config/opencode/opencode.json  — opencode (провайдеры/модели/агенты/MCP)
#   honcho/.env                       — модели honcho (deriver/dialectic/summary)
#
# Usage:
#   ./configure.sh                          перегенерировать из stack.config
#   ./configure.sh set-model local|remote MODEL   переключить основную модель
#   ./configure.sh set-vision MODEL BASE_URL [API_KEY]   включить vision
#   ./configure.sh set-agent-model AGENT MODEL   модель конкретного суб-агента
#   ./configure.sh --print                       показать итоговый конфиг
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

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
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

# Модели суб-агентов (пусто = наследовать модель сессии)
AGENT_MODEL_GENERAL="${AGENT_MODEL_GENERAL:-}"
AGENT_MODEL_EXPLORE="${AGENT_MODEL_EXPLORE:-}"
AGENT_MODEL_IMPLEMENTER="${AGENT_MODEL_IMPLEMENTER:-local/coder}"
AGENT_MODEL_REVIEWER="${AGENT_MODEL_REVIEWER:-local/coder}"

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

# ---------- генерация opencode.json ----------
[ "$1" = "--print" ] && OUT=/dev/stdout || OUT="$CONFIG_DIR/opencode.json"
mkdir -p "$CONFIG_DIR"
[ -f "$OUT" ] && [ "$1" != "--print" ] && cp "$OUT" "$OUT.bak.$(date +%s)" 2>/dev/null || true

export ROOT LOCAL_LLM_BASE_URL LOCAL_LLM_MODEL REMOTE_BASE_URL REMOTE_API_KEY REMOTE_MODEL \
       OPENCODE_MODEL VISION_MODEL VISION_BASE_URL VISION_API_KEY CHROME_PATH \
       AGENT_MODEL_GENERAL AGENT_MODEL_EXPLORE AGENT_MODEL_IMPLEMENTER AGENT_MODEL_REVIEWER

python3 - "$OUT" <<'PY'
import json, os, sys
root   = os.environ["ROOT"]
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

def am(name):
    v = os.environ.get(f"AGENT_MODEL_{name.upper()}","")
    return v or None

providers = {
  "local": {
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
  },
}
if remote_b:
    providers["remote"] = {
        "name": "Remote OpenAI-compatible",
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": remote_b, "apiKey": remote_k or "x"},
        "models": {"main": {"modelID": remote_m or "main", "limit": {"context": 200000, "output": 32768}}},
    }

agents = {}
for name in ("general","explore","implementer","reviewer"):
    m = am(name)
    if m:
        agents[name] = {"model": m}
# implementer/reviewer объявлены и в agents/*.md — здесь только модель

servers = {
  "rag": {"type":"local","command":["node", f"{root}/mcp/rag-server.mjs"], "enabled": True},
  "chrome-devtools": {"type":"local","command":[
        "npx","-y","chrome-devtools-mcp@latest","--headless","--no-sandbox",
        "--chromeArg=--no-sandbox","--chromeArg=--disable-setuid-sandbox",
        "--chromeArg=--disable-dev-shm-usage","--chromeArg=--disable-gpu",
        "--no-usage-statistics","--no-performance-crux","--isolated",
        "--executable-path", chrome], "enabled": True},
  "playwright": {"type":"local","command":[
        "npx","-y","@playwright/mcp@latest","--headless","--no-sandbox",
        "--browser","chromium","--isolated"], "enabled": True},
}
if vis_m:
    servers["vision"] = {"type":"local",
        "command":["node", f"{root}/mcp/vision-server.mjs"],
        "environment":{"OPENAI_BASE_URL":vis_b,"OPENAI_API_KEY":vis_k,"VISION_MODEL":vis_m},
        "enabled": True}

cfg = {
  "$schema": "https://opencode.ai/config.json",
  "model": open_model,
  "providers": providers,
  "mcp": {"servers": servers},
  "experimental": {"mcp_timeout": 300000},
}
if agents:
    cfg["agents"] = agents

out = sys.argv[1]
if out != "/dev/stdout":
    with open(out,"w") as f: f.write(json.dumps(cfg, indent=2, ensure_ascii=False)+"\n")
    print(f"[ok] opencode config -> {out}")
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
[ -n "$remote_b" ] && echo "  удалённая LLM:   $REMOTE_BASE_URL ($REMOTE_MODEL)" || echo "  удалённая LLM:   не настроена (добавь REMOTE_* в stack.config)"
[ -n "$vis_m" ] && echo "  vision:          $VISION_MODEL (@ $VIS_BASE_URL)" || echo "  vision:          выключен (configure.sh set-vision ...)"
echo
echo "Проверь: opencode → /models (выбор модели в сессии), mcp список, конфиг: $( [ "$1" = "--print" ] && echo stdout || echo $CONFIG_DIR/opencode.json )"