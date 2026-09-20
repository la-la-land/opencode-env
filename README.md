# opencode-env

Развёртываемое окружение для **агентной разработки с opencode**: установщик, стек
инфраструктуры (LLM / эмбеддинги / RAG / браузер), конфиг, агенты и локальная
память (Honcho). Всё локально, без облачных сервисов. Одна локальная модель —
**Gemma 4 12B**; любые другие модели подключаются как **удалённые провайдеры**.

```
llama.cpp (:1234)  ── Gemma 4 12B (основная модель opencode)
llama.cpp (:8095)  ── bge-m3 (эмбеддинги для RAG)
Qdrant   (:6333)   ── векторная БД (RAG)
Honcho   (:8000)   ── память агента (docker: api+deriver+redis+pgvector+embedder)
MCP              ── rag, vision, chrome-devtools, playwright
```

---

## Требования

- Linux, `bash`, `curl`, `git`, `python3` (3.10+), `node` (22+, нужен `node:sqlite`)
- GPU NVIDIA (для локальной Gemma 12B; 16 GB VRAM достаточно). Без GPU —
  локальный RAG/эмбеддинги работают, LLM — через удалённый провайдер.
- Для Honcho: `docker` с compose v2.

## Быстрый старт (новый ПК)

```sh
git clone git@github.com:la-la-land/opencode-env.git
cd opencode-env

make setup WITH_HONCHO=1     # полная установка: CUDA + llama.cpp + модели + Qdrant + honcho
make start                   # поднять стек: embed :8095, qdrant :6333, main :1234
make health                  # статус всех сервисов
```

Установка делает (см. `setup.sh`):

1. Детект GPU, установка pip-пакетов nvidia (CUDA 13) при наличии GPU.
2. Сборка `llama.cpp` (llama-server) с GPU-поддержкой.
3. Скачивание моделей: **Gemma 4 12B** (Q4_K_M, 6.7 GB) и **bge-m3** (Q8, 606 MB).
4. Установка **Qdrant** (tar.gz по архитектуре, без Docker).
5. Опционально **Honcho** (docker) — локальная память.
6. Генерация конфига opencode (**`configure.sh`** из `stack.config`).

Никаких моделей/бинарей в git — всё скачивается/собирается на месте.

## Подстройка под модель (главное)

Всё окружение настраивается из **одного файла** `stack.config` (копия шаблона —
`stack.config.example`; сам `stack.config` в git не попадает, там могут быть ключи):

```sh
# stack.config
OPENCODE_MODEL=local/coder        # основная модель opencode
LOCAL_LLM_BASE_URL=http://127.0.0.1:1234/v1
LOCAL_LLM_MODEL=local-coder
REMOTE_BASE_URL=                  # пусто = удалённый провайдер не подключается
REMOTE_API_KEY=
REMOTE_MODEL=
VISION_MODEL=                     # пусто = vision-mcp выключен
VISION_BASE_URL=
VISION_API_KEY=
HONCHO_LLM_BASE_URL=http://host.docker.internal:1234/v1   # адрес LLM для honcho
HONCHO_LLM_MODEL=local-coder
AGENT_MODEL_GENERAL=              # пусто = агенты наследуют модель сессии
AGENT_MODEL_EXPLORE=
AGENT_MODEL_IMPLEMENTER=local/coder
AGENT_MODEL_REVIEWER=local/coder
```

После правки — перегенерировать конфиги:

```sh
./configure.sh          # или make config
```

`configure.sh` пишет:

- `~/.config/opencode/opencode.json` — провайдеры (local + remote при наличии),
  агенты (модель или наследование), MCP-серверы (vision подключается только если
  задан `VISION_MODEL`);
- `honcho/.env` — модели deriver/dialectic/summary/dream для Honcho.

Быстрое переключение:

```sh
make set-model BACKEND=local MODEL=coder          # локальная Gemma
make set-model BACKEND=remote MODEL=my-remote     # удалённая (задай REMOTE_* в stack.config)
make set-vision MODEL=qwen3-vl-flash BASE=https://api.minimax.io/v1 KEY=...
make set-agent-model AGENT=explore MODEL=remote/main
```

**Агенты** (`agents/*.md`): по умолчанию наследуют модель сессии — при смене
модели в opencode (`/models`) они подстраиваются автоматически. Чтобы закрепить
конкретную модель за агентом — `stack.config` → `AGENT_MODEL_*` или
`make set-agent-model`.

**Примеры конфигов**: `opencode.json.example` — читаемый шаблон с комментариями
(для референса, ручная правка), `configure.sh` — генерация из `stack.config`.

## Запуск/остановка стека

```sh
./start.sh all        # embed + qdrant + main
./start.sh health     # статус: 1234 LLM, 8095 embed, 6333 qdrant, 8000 honcho
./start.sh stop       # остановить llama.cpp и qdrant (honcho — docker, не трогаем)
```

Полезное в `start.sh`:

- Автоопределение CUDA-библиотек (pip-пакеты `nvidia/cu13`, системная CUDA);
  переопределить: `LLMSTACK_CUDA_LIB=/path` `./start.sh main`.
- Без GPU `main` не запускается — работай через удалённый провайдер.

## MCP-серверы

Подключаются в `opencode.json` автоматически (`configure.sh`):

| Сервер | Что делает |
|---|---|
| `rag` | поиск по коду проекта (лексика + BM25 + семантика bge-m3), база знаний `PROJECT_KNOWLEDGE.md` (инструменты `notix_search`, `notix_where`, `notix_summary`, `notix_stats`, `notix_kb_read`, `notix_kb_add`) |
| `vision` | картинки: метаданные, OCR (offline), `describe_image` через любую OpenAI-совместимую vision-модель. Выключен, пока не задан `VISION_MODEL` |
| `chrome-devtools` | браузерная автоматизация (находит Chrome по `CHROME_PATH` в `stack.config`) |
| `playwright` | браузерная автоматизация |

### RAG-индексация

```sh
make start                      # поднять стек (нужен embed :8095 для векторов)
# 1) построить индекс кода (по умолчанию — текущий каталог):
RAG_ROOT=/path/to/your/project node mcp/build-index.mjs
# 2) посчитать эмбеддинги (bge-m3 :8095) — без этого поиск только лексический:
node mcp/embed.mjs
```

Пути индекса: `rag/notix.db` и `rag/PROJECT_KNOWLEDGE.md` (переопределяются
`RAG_DB`, `RAG_KB`, `RAG_ROOT`, `RAG_EMBED_URL`). Всё — в `.gitignore`.

## Honcho (локальная память агента)

См. `honcho/README.md`. Коротко:

```sh
make start        # нужна запущенная LLM :1234
make honcho       # ./honcho/setup-honcho.sh: clone plastic-labs/honcho + docker compose up
curl http://127.0.0.1:8000/health   # проверка
```

Все LLM-вызовы honcho (deriver/dialectic/summary/dream) идут на модель из
`HONCHO_LLM_*` в `stack.config` (по умолчанию — локальная Gemma через
`host.docker.internal:1234`). Эмбеддинги — собственный контейнер honcho
(`:8100`, paraphrase-multilingual-MiniLM-L12-v2).

## Модели

| Роль | Модель | Файл | URL (HuggingFace) |
|---|---|---|---|
| Основная LLM | Gemma 4 12B it (256K) | `gemma-4-12b-it-Q4_K_M.gguf` (6.7 GB) | `unsloth/gemma-4-12b-it-GGUF` |
| Эмбеддинги | bge-m3 | `bge-m3-q8_0.gguf` (606 MB) | `vonjack/bge-m3-gguf` |

Любые другие модели (вижн, кодер, инструменты) — удалёнными провайдерами:
`REMOTE_*` / `VISION_*` в `stack.config`.

## Каталог репозитория

```
setup.sh                 установщик (CUDA, llama.cpp, модели, Qdrant, honcho)
configure.sh             генератор конфигов из stack.config
start.sh                 стек-менеджер (all/embed/main/qdrant/stop/health)
Makefile                 обёртки над setup/configure/start
opencode.json.example    шаблон конфига opencode (референс)
stack.config.example     шаблон единой точки настройки моделей
agents/                  кастомные агенты (implementer, reviewer)
mcp/                     MCP-серверы (rag, vision, build-index, embed)
honcho/                  развёртывание локальной памяти (docker)
qdrant/config.yaml       конфиг Qdrant (:6333, dim 1024)
```

## FAQ

- **Нет GPU?** `make setup BACKEND=remote` — только инфраструктура; любую модель
  подключаешь в `stack.config` (REMOTE_*). Эмбеддинги/RAG работают на CPU.
- **Хочу другую локальную модель?** Положи GGUF в `models/`, замени
  `LOCAL_LLM_MODEL`/`--alias` в `stack.config` и `start.sh`.
- **Vision?** `make set-vision MODEL=... BASE=... KEY=...` — vision-mcp
  подключится; `describe_image` работает через любую OpenAI-совместимую
  мультимодалку.
- **Сменить агента на другую модель?** `make set-agent-model AGENT=explore MODEL=remote/main`
  или вообще убрать модель — агент унаследует модель сессии.

Лицензия: MIT.