# honcho — локальная память агента (Honcho v3)

Разворачивает Honcho в Docker **полностью локально** (без mcp.honcho.dev и API-ключей):
API + deriver + redis + pgvector + embedder. Все LLM-вызовы honcho
(deriver, dialectic, summary, dream) идут на **локальную Gemma 4 12B** (:1234).

## Быстрый старт

```sh
# 1) сначала подними стек с моделью:  ../start.sh main   (или make start в корне)
# 2) разверни honcho:
./setup-honcho.sh
# 3) проверь:  curl http://127.0.0.1:8000/health
```

## Что делает setup-honcho.sh

1. Клонирует официальный `plastic-labs/honcho` в `~/honcho` (разово).
2. Копирует `honcho/.env` (если сгенерирован `configure.sh`) либо `.env.template`.
3. Копирует `docker-compose.override.yml` (доступ контейнеров к `host.docker.internal`).
4. `docker compose up -d --build` и ждёт готовности `:8000`.

## Подстройка под модель

Адреса моделей honcho задаются в `../stack.config`:

```sh
HONCHO_LLM_BASE_URL=http://host.docker.internal:1234/v1   # локальная Gemma
HONCHO_LLM_MODEL=local-coder
```

После правки: `./configure.sh` (корень репо) перегенерирует `honcho/.env`.
Нет локальной модели (ноутбук)? Подставь любую OpenAI-совместимую endpoint.
Эмбеддинги honcho использует собственный контейнер (`embedding:8100`,
paraphrase-multilingual-MiniLM-L12-v2) — ему внешняя модель не нужна.

## Связь с opencode

Плагин `@honcho-ai/opencode-honcho` ведёт сессии per-directory и хранит память
через этот же API (`http://127.0.0.1:8000`). Альтернатива плагину — honcho MCP.

## Часто

- Остановить: `docker compose -f ~/honcho/docker-compose.yml down` (данные в volume остаются)
- Логи: `docker compose -f ~/honcho/docker-compose.yml logs -f api`
- Данные: volumes `pgdata`, `redis-data`