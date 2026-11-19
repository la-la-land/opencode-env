#!/usr/bin/env bash
# opencode-env / honcho — развёртывание локальной памяти (Honcho v3)
#   1) клонирует официальный plastic-labs/honcho (если нужно)
#   2) кладёт .env (из шаблона — LLM памяти удалённый, OpenAI-совместимый;
#      эмбеддинги — локальный llama.cpp :8095 на хосте)
#   3) кладёт docker-compose.override.yml (доступ контейнеров к llama.cpp на хосте)
#   4) docker compose up -d (образы соберутся при первом запуске, дальше — мгновенно)
# Требует: docker (compose v2). Переменные: HONCHO_SRC (по умолч. ~/honcho), HONCHO_REPO.
set -euo pipefail
cd "$(dirname "$0")"
HONCHO_SRC="${HONCHO_SRC:-$HOME/honcho}"
HONCHO_REPO="${HONCHO_REPO:-https://github.com/plastic-labs/honcho.git}"

command -v docker >/dev/null 2>&1 || { echo "[fail] нужен docker (https://docs.docker.com/engine/install/)"; exit 1; }

if [ ! -d "$HONCHO_SRC/.git" ]; then
  echo "клонирую honcho ($HONCHO_REPO)..."
  git clone --depth 1 "$HONCHO_REPO" "$HONCHO_SRC"
fi

# .env — источник: <repo>/honcho/.env (его генерирует configure.sh из stack.config).
# Если его нет — генерируем (нужны реальные значения, шаблон содержит плейсхолдеры).
SRC_ENV="../honcho/.env"
if [ ! -f "$SRC_ENV" ]; then
  echo "[..] генерирую honcho/.env через configure.sh..."
  (cd .. && ./configure.sh >/dev/null) || { echo "[fail] configure.sh не отработал — нет honcho/.env"; exit 1; }
fi
[ -f "$SRC_ENV" ] || { echo "[fail] нет $SRC_ENV (сгенерируй: ./configure.sh)"; exit 1; }

# обновляем .env в каталоге honcho: если новый файл содержит реальный ключ LLM —
# копируем (с бэкапом старого), иначе оставляем существующий (не ломаем рабочий стек).
new_key="$(grep -m1 '^LLM_OPENAI_API_KEY=' "$SRC_ENV" | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ ! -f "$HONCHO_SRC/.env" ]; then
  cp "$SRC_ENV" "$HONCHO_SRC/.env"; chmod 600 "$HONCHO_SRC/.env" 2>/dev/null || true
  echo "[ok] honcho/.env создан"
elif cmp -s "$SRC_ENV" "$HONCHO_SRC/.env"; then
  echo "[ok] honcho/.env актуален"
elif [ "$new_key" = "local" ] || [ -z "$new_key" ]; then
  echo "[warn] в <repo>/honcho/.env нет реального ключа LLM (LLM_OPENAI_API_KEY=local) —"
  echo "       существующий ~/honcho/.env НЕ трогаю. Сгенерируй ключ: ./honcho/fetch-llm-key.sh"
  echo "       или пропиши HONCHO_LLM_API_KEY в stack.config и повтори ./configure.sh"
elif [ "${HONCHO_ENV_KEEP:-0}" = "1" ]; then
  echo "[warn] ~/honcho/.env отличается от <repo>/honcho/.env — не трогаю (HONCHO_ENV_KEEP=1)."
else
  # по умолчанию обновляем (с бэкапом): конфиг из stack.config должен доезжать
  # до контейнера, иначе смена модели/размерности не применится
  cp -p "$HONCHO_SRC/.env" "$HONCHO_SRC/.env.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$SRC_ENV" "$HONCHO_SRC/.env"; chmod 600 "$HONCHO_SRC/.env" 2>/dev/null || true
  echo "[ok] honcho/.env обновлён из <repo>/honcho/.env (бэкап: ~/honcho/.env.bak.*)"
fi

cp docker-compose.override.yml "$HONCHO_SRC/docker-compose.override.yml"

# tiktoken-кэш: без него контейнер api зависает на старте (сеть до
# openaipublic.blob.core.windows.net в этой машине режется).
# зовём через bash — не зависим от бита +x на файле
bash ./fetch-tiktoken-cache.sh "$HONCHO_SRC/.tiktoken-cache"

cd "$HONCHO_SRC"
echo "поднимаю контейнеры (при первом запуске — сборка образов; дальше — моментом)..."
docker compose up -d

echo "ждём API на :8000..."
for i in $(seq 1 60); do
  curl -sf --max-time 2 http://127.0.0.1:8000/health >/dev/null 2>&1 && { echo "[ok] honcho UP: http://127.0.0.1:8000"; exit 0; }
  sleep 5
done
echo "[fail] honcho не ответил за 5 минут. Смотри: docker compose logs api"
exit 1