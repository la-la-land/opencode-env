#!/usr/bin/env bash
# ============================================================
# opencode-env / honcho/fetch-llm-key.sh
#
# Достаёт API-ключ MiniMax из локальной базы opencode:
#   ~/.local/share/opencode/opencode.db → таблица credential
#   label = "MiniMax Token Plan (minimax.io)"
#   value = {"type":"key","key":"sk-..."}
#
# Ключ печатается в stdout (одна строка) — так его можно подставить
# в любое место:  KEY="$(honcho/fetch-llm-key.sh)"
#
# Если ключа нет — exit 1 с понятным сообщением (в stderr).
#
# Переменные:
#   OPENCODE_DB — путь к базе opencode (по умолчанию ~/.local/share/opencode/opencode.db)
#
# Инструменты: sqlite3 (если есть) или python3 (sqlite3 из stdlib).
# ============================================================
set -euo pipefail

DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"

if [ ! -f "$DB" ]; then
  echo "[fail] база opencode не найдена: $DB" >&2
  echo "       укажи путь через OPENCODE_DB или задай HONCHO_LLM_API_KEY в stack.config" >&2
  exit 1
fi

# --- 1) sqlite3 CLI (самый быстрый путь) ---
if command -v sqlite3 >/dev/null 2>&1; then
  KEY="$(sqlite3 -noheader "file:$DB?mode=ro" \
    "SELECT json_extract(value, '\$.key') FROM credential WHERE lower(label) LIKE '%minimax%' LIMIT 1;" \
    2>/dev/null || true)"
  if [ -n "${KEY:-}" ]; then
    printf '%s\n' "$KEY"
    exit 0
  fi
fi

# --- 2) python3 (sqlite3 из stdlib) — если CLI нет или без JSON1 ---
if command -v python3 >/dev/null 2>&1; then
  KEY="$(python3 - "$DB" <<'PY' 2>/dev/null || true
import json, sqlite3, sys

db = sys.argv[1]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
try:
    rows = con.execute("SELECT label, value FROM credential").fetchall()
finally:
    con.close()

for label, value in rows:
    if "minimax" not in (label or "").lower():
        continue
    try:
        parsed = json.loads(value)
    except Exception:
        continue
    key = parsed.get("key") if isinstance(parsed, dict) else None
    if key:
        print(key)
        break
PY
)"
  if [ -n "${KEY:-}" ]; then
    printf '%s\n' "$KEY"
    exit 0
  fi
fi

echo "[fail] ключ MiniMax не найден в таблице credential базы $DB" >&2
echo "       варианты: задай HONCHO_LLM_API_KEY в stack.config" >&2
echo "       или экспортируй HONCHO_LLM_API_KEY=... в окружении" >&2
exit 1
