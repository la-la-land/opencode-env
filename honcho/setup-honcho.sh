#!/usr/bin/env bash
# opencode-env / honcho — развёртывание локальной памяти (Honcho v3)
#   1) клонирует официальный plastic-labs/honcho (если нужно)
#   2) кладёт .env (из шаблона — модели на локальную Gemma :1234)
#   3) кладёт docker-compose.override.yml (доступ контейнеров к llama.cpp на хосте)
#   4) docker compose up -d --build
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

# .env — только если нет (не перезаписываем уже настроенный)
if [ ! -f "$HONCHO_SRC/.env" ]; then
  [ -f ../honcho/.env ] && cp ../honcho/.env "$HONCHO_SRC/.env" || cp .env.template "$HONCHO_SRC/.env"
  echo "[ok] honcho/.env создан"
else
  echo "[warn] honcho/.env уже есть — не трогаю. Проверь адреса моделей."
fi

cp docker-compose.override.yml "$HONCHO_SRC/docker-compose.override.yml"

cd "$HONCHO_SRC"
echo "собираю и поднимаю контейнеры (первые минуты — сборка)..."
docker compose up -d --build

echo "ждём API на :8000..."
for i in $(seq 1 60); do
  curl -sf --max-time 2 http://127.0.0.1:8000/health >/dev/null 2>&1 && { echo "[ok] honcho UP: http://127.0.0.1:8000"; exit 0; }
  sleep 5
done
echo "[fail] honcho не ответил за 5 минут. Смотри: docker compose logs api"
exit 1