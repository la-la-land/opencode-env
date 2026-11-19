# honcho — локальная память агента (Honcho v3)

Разворачивает Honcho в Docker (без mcp.honcho.dev): API + deriver + redis +
pgvector + embedder. Все LLM-вызовы honcho (deriver, dialectic, summary, dream)
идут на **удалённый OpenAI-совместимый endpoint** (по умолчанию MiniMax).

## Быстрый старт

```sh
# 1) сначала подними стек с моделью:  ../start.sh infra   (или make infra в корне)
# 2) разверни honcho:
./setup-honcho.sh
# 3) проверь:  curl http://127.0.0.1:8000/health
```

> Локальной LLM в проекте нет — llama.cpp работает только как embed-сервер
> (:8095). Модель для агента выбирается в opencode (/models).

## Что делает setup-honcho.sh

1. Клонирует официальный `plastic-labs/honcho` в `~/honcho` (разово).
2. Копирует `honcho/.env` (если сгенерирован `configure.sh`) либо `.env.template`.
3. Копирует `docker-compose.override.yml` (доступ контейнеров к `host.docker.internal`).
4. `docker compose up -d --build` и ждёт готовности `:8000`.

## Подстройка под модель

Адреса моделей honcho задаются в `../stack.config`:

```sh
HONCHO_LLM_BASE_URL=https://api.minimax.io/v1   # удалённый OpenAI-совместимый endpoint
HONCHO_LLM_MODEL=MiniMax-M3
HONCHO_LLM_API_KEY=<ваш ключ>                   # необязательно: возьмётся из opencode.db
```

После правки: `./configure.sh` (корень репо) перегенерирует `honcho/.env`.
Эмбеддинги honcho берутся с локального llama.cpp на хосте
(`host.docker.internal:8095`) — модель и размерность из `EMBED_MODEL`/
`EMBED_DIM` в `stack.config` (MiniLM 384-dim или bge-m3 1024-dim).

## Связь с opencode

Плагин `@honcho-ai/opencode-honcho` ведёт сессии per-directory и хранит память
через этот же API (`http://127.0.0.1:8000`). Альтернатива плагину — honcho MCP.

## Часто

- Остановить: `docker compose -f ~/honcho/docker-compose.yml down` (данные в volume остаются)
- Логи: `docker compose -f ~/honcho/docker-compose.yml logs -f api`
- Данные: volumes `pgdata`, `redis-data`