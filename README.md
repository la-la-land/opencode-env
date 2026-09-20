# opencode-env

Развёртываемое окружение для **агентной разработки с opencode**: установщик, стек
инфраструктуры (эмбеддинги / RAG / браузер / память), конфиг, агенты и локальная
память (Honcho). Всё локально, без облачных сервисов.

**Главный принцип: локальная LLM не обязательна и не ставится по умолчанию.**
Модель для работы берётся из **выбранной в opencode-сессии** (`/models`) —
она же наследуется суб-агентами. Локальная **Gemma 4 12B** ставится отдельной
командой, если нужна (`make model-gemma`). Любые другие модели — удалённые
провайдеры (в `opencode.json` / `stack.config`).

```
llama.cpp (:8095)  ── bge-m3 (эмбеддинги для RAG, работает на CPU)
llama.cpp (:1234)  ── Gemma 4 12B (ОПЦИОНАЛЬНО, только если установлена)
Qdrant   (:6333)   ── векторная БД (RAG)
Honcho   (:8000)   ── память агента (docker), LLM для него задаётся отдельно
MCP              ── rag, vision, chrome-devtools, playwright
```

---

## Требования

- Linux, `bash`, `curl`, `git`, `python3` (3.10+), `node` (22+, нужен `node:sqlite`)
- GPU NVIDIA нужна **только** для локальной Gemma (16 GB VRAM достаточно).
  Всё остальное (RAG, эмбеддинги, браузер) работает на CPU/без GPU.
- Для Honcho: `docker` с compose v2.

## Быстрый старт (новый ПК) — сценарий «без локальной LLM»

Это режим по умолчанию: подходит ноутбуку, серверу без GPU и всем, кто не хочет
тянуть 6.7 GB модель. Инфраструктура (RAG/эмбеддинги/honcho/MCP) разворачивается
полностью, а модели подставляются из выбранных в opencode.

```sh
git clone git@github.com:la-la-land/opencode-env.git
cd opencode-env

# 1) настройка: впиши удалённого провайдера (модель для агентов)
cp stack.config.example stack.config
#    → OPENCODE_MODEL=remote/main; REMOTE_BASE_URL/API_KEY/MODEL (твой провайдер)
#    → VISION_* (по желанию), HONCHO_LLM_* (по желанию)

# 2) установка инфраструктуры + honcho + генерация конфига opencode
make setup WITH_HONCHO=1

# 3) запуск (без локальной LLM: embed + qdrant)
make infra

# 4) в проекте — opencode сам подхватит конфиг и все MCP
opencode            # модель: /models (удалённая), суб-агенты наследуют её
```

Что делает установка (см. `setup.sh`):

1. Сборка `llama.cpp` (CPU-версия — для embed bge-m3; RAG-семантика работает).
2. Скачивание **bge-m3** (Q8, 606 MB) — эмбеддинги для RAG.
3. Установка **Qdrant** (tar.gz, без Docker).
4. Опционально **Honcho** (docker) — локальная память.
5. Генерация конфига opencode (**`configure.sh`** из `stack.config`).

Никаких моделей/бинарей в git — всё скачивается/собирается на месте.

## Локальная Gemma — отдельной командой (если нужна)

```sh
make model-gemma       # собрать llama.cpp с CUDA + скачать Gemma 4 12B (6.7 GB)
make start             # поднять всё: embed :8095 + qdrant :6333 + main :1234
```

`model-gemma` пересобирает llama.cpp с CUDA (pip-пакеты nvidia ставятся сами).
Модель в конфиге: `OPENCODE_MODEL=local/coder` (`local` провайдер подключается
всегда).

## Модель берётся из выбранной в сессии

- **Основной агент**: любая модель из `providers` — переключение в opencode
  через `/models` прямо во время работы.
- **Суб-агенты** (`general`, `explore`, `implementer`, `reviewer`): по умолчанию
  **наследуют модель текущей сессии** — одна команда `/models` переключает весь
  функционал. Закрепить свою модель за агентом:
  `stack.config` → `AGENT_MODEL_*` или `make set-agent-model AGENT=... MODEL=...`.
- **Инструменты (MCP)**: вызываются моделью сессии автоматически — RAG/браузер/
  vision-OCR не привязаны ни к какому LLM-адресу. Своя модель нужна только
  `vision` (для «описания картинки» — `VISION_*`) и `honcho` (см. ниже).

```sh
make set-model BACKEND=remote MODEL=main        # удалённая — для всех
make set-model BACKEND=local MODEL=coder        # вернуть локальную Gemma
make set-vision MODEL=qwen3-vl-flash BASE=https://api.minimax.io/v1 KEY=...
```

`configure.sh` при этом пишет:

- `~/.config/opencode/opencode.json` (или `--dir <проект>` — прямо в проект)
  — провайдеры, агенты (модель или наследование), MCP;
- `honcho/.env` — модели для honcho.

## Подстройка под модель

Всё настраивается из **одного файла** `stack.config` (шаблон — `stack.config.example`; сам `stack.config` не в git — там могут быть ключи):

```sh
# stack.config
OPENCODE_MODEL=remote/main            # модель по умолчанию при старте сессии
REMOTE_BASE_URL=                      # удалённый провайдер (или local/coder)
REMOTE_API_KEY=
REMOTE_MODEL=
VISION_MODEL=                         # пусто = vision-mcp выключен
VISION_BASE_URL=
VISION_API_KEY=
HONCHO_LLM_BASE_URL=                  # LLM для honcho (из-за docker: host.docker.internal)
HONCHO_LLM_MODEL=
AGENT_MODEL_GENERAL=                  # пусто = наследуют модель сессии
AGENT_MODEL_EXPLORE=
AGENT_MODEL_IMPLEMENTER=
AGENT_MODEL_REVIEWER=
```

## Запуск/остановка стека

```sh
make infra           # ./start.sh infra — embed :8095 + qdrant :6333 (без LLM)
./start.sh all       # + main :1234 (только если установлена Gemma)
./start.sh health    # статус: 1234 LLM, 8095 embed, 6333 qdrant, 8000 honcho
./start.sh stop      # остановить llama.cpp и qdrant (honcho — docker, не трогаем)
```

Полезное в `start.sh`:

- Автоопределение CUDA-библиотек (pip-пакеты `nvidia/cu13`, системная CUDA);
  переопределить: `LLMSTACK_CUDA_LIB=/path` `./start.sh main`.
- Без GPU `main` не запускается — работай через удалённый провайдер.

## MCP-серверы

Подключаются в `opencode.json` автоматически (`configure.sh`):

| Сервер | Что делает |
|---|---|
| `rag` | поиск по коду **нескольких проектов** (лексика + BM25 + семантика bge-m3). Активный проект определяется по рабочей директории (`cwd` opencode) — где кодим, тот индекс и ищется. Инструменты: `rag_search`, `rag_where`, `rag_summary`, `rag_stats`, `rag_project` (активный + список), `kb_read`, `kb_add` |
| `honcho` | пер-проектная память агента: свой workspace `project-<имя>` и сессии на каждый проект, авто-детект по `cwd`. Инструменты: `honcho_sessions`, `honcho_memories`, `honcho_recall` (поиск по памяти), `honcho_save` |
| `vision` | картинки: метаданные, OCR (offline), `describe_image` через любую OpenAI-совместимую vision-модель. Выключен, пока не задан `VISION_MODEL` |
| `chrome-devtools` | браузерная автоматизация (находит Chrome по `CHROME_PATH` в `stack.config`) |
| `playwright` | браузерная автоматизация |

### RAG-индексация (несколько проектов)

Каждый проект индексируется отдельно, в свой каталог (имя — как у папки
проекта, или задаётся `--name`):

```sh
make infra                     # embed :8095 + qdrant :6333 (модель не нужна)
# 1) построить индекс проекта (чанки + лексика → sqlite):
node mcp/build-index.mjs --project /path/to/project      # имя = имя папки
node mcp/build-index.mjs --project /path/to/api --name api
node mcp/build-index.mjs --list                          # что уже проиндексировано
# 2) залить ВЕКТОРА в Qdrant (bge-m3 :8095): все проекты без эмбеддингов
node mcp/embed.mjs
node mcp/embed.mjs --project api                         # или только один
node mcp/embed.mjs --project api --reset                 # пересоздать коллекцию
```

Хранение разделено: **sqlite** (`rag/projects/<имя>/index.db`) — чанки,
токены для BM25, `PROJECT_KNOWLEDGE.md`, `project.path`; **Qdrant** (:6333,
коллекция `rag_<имя>`, dim 1024, cosine) — эмбеддинги чанков. Без Qdrant
поиск остаётся лексическим (BM25), семантика добавляется автоматически.

**Как выбирается проект**: MCP-сервер `rag` смотрит на рабочий каталог
opencode — берётся индекс проекта с самым длинным префиксом пути (глубина
вложенности не важна). Так что в разных проектах один и тот же opencode
ищет по своему индексу. Переключение вручную — параметр `project` любого
инструмента (см. `rag_project`) или `RAG_PROJECT=<имя>`.

## Honcho (пер-проектная память агента)

Память изолирована **по проектам**: каждому проекту — отдельный workspace
`project-<имя>` со своими сессиями. Активный проект определяется так же, как
у RAG — по рабочей директории (проект = самый длинный префикс пути среди
RAG-индексов, либо ближайший git-репозиторий, либо имя текущей папки).

```sh
make honcho            # ./honcho/setup-honcho.sh: clone plastic-labs/honcho + docker compose up
curl http://127.0.0.1:8000/health   # проверка
```

Инструменты (MCP-сервер `honcho`, подключается `configure.sh`):

- `honcho_sessions` — сессии текущего проекта;
- `honcho_save` — сохранить факт/заметку в память проекта;
- `honcho_recall` — семантический поиск по памяти проекта («что мы решали
  по поводу биллинга?»);
- `honcho_memories` — сколько сообщений накоплено по каждой сессии.

Следующая сессия агента в том же каталоге подхватит эту память автоматически.

LLM для honcho (deriver/dialectic/summary/dream) задаётся в `stack.config`:
`HONCHO_LLM_BASE_URL` / `HONCHO_LLM_MODEL` — укажи явно адрес любой
OpenAI-совместимой модели (honcho живёт в docker, поэтому для локальной —
`host.docker.internal:1234`, а не `127.0.0.1`). Эмбеддинги — собственный
контейнер honcho (`:8100`, paraphrase-multilingual-MiniLM-L12-v2).

## Модели

| Роль | Модель | Файл | URL (HuggingFace) |
|---|---|---|---|
| Основная LLM (опционально, `make model-gemma`) | Gemma 4 12B it (256K) | `gemma-4-12b-it-Q4_K_M.gguf` (6.7 GB) | `unsloth/gemma-4-12b-it-GGUF` |
| Эмбеддинги (всегда, для RAG) | bge-m3 | `bge-m3-q8_0.gguf` (606 MB) | `vonjack/bge-m3-gguf` |

Любые другие модели (кодер, вижн, инструменты) — удалённые провайдеры:
`REMOTE_*` / `VISION_*` / `HONCHO_LLM_*` в `stack.config`.

## Каталог репозитория

```
setup.sh                 установщик (CUDA, llama.cpp, модели, Qdrant, honcho)
configure.sh             генератор конфигов из stack.config (opencode.json, honcho/.env)
start.sh                 стек-менеджер (all/infra/embed/main/qdrant/stop/health)
Makefile                 обёртки над setup/configure/start
stack.config.example     шаблон единой точки настройки моделей
agents/                  кастомные агенты (implementer, reviewer)
mcp/                     MCP-серверы: rag-server (поиск), honcho-server (память),
                         vision-server + build-index.mjs/embed.mjs (индексация)
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
- **Несколько проектов?** Индексируй каждый: `node mcp/build-index.mjs --project /path --name alias`.
  Сервер сам выберет нужный индекс по рабочей директории (`rag_project` покажет активный).
- **Сменить агента на другую модель?** `make set-agent-model AGENT=explore MODEL=remote/main`
  или вообще убрать модель — агент унаследует модель сессии.

Лицензия: MIT.