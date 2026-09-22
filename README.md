# opencode-env

Развёртываемое окружение для **агентной разработки с opencode**: установщик, стек
инфраструктуры (эмбеддинги / RAG / браузер / память), конфиг, агенты и локальная
память (Honcho). Всё локально, без облачных сервисов.

**Главный принцип: локальная LLM не обязательна и не ставится по умолчанию.**
Модель для работы берётся из **выбранной в opencode-сессии** (`/models`) —
она же наследуется суб-агентами. Локальная **Gemma 4 12B** ставится отдельной
командой, если нужна (`make model-gemma`). Удалённые модели — провайдеры,
которые добавляются нативно в opencode (`/providers`, `auth login`,
`provider add`); наш configure.sh их не трогает.

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

# 1) настройка MCP-стеков (модель/провайдеры НЕ трогаем — добавляются нативно)
cp stack.config.example stack.config
#    → VISION_* (по желанию), HONCHO_LLM_* (по желанию)
#    → удалённый провайдер: opencode → /providers (auth login / provider add)

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
Провайдер `local` (llama.cpp) подключается всегда; модель выбираешь в `/models`
(`local/coder`, если установлена Gemma).

## Модель берётся из выбранной в сессии

- **Основной агент**: любая модель из `providers` — переключение в opencode
  через `/models` прямо во время работы.
- **Суб-агенты** (`general`, `explore`, `implementer`, `reviewer`): **наследуют
  модель текущей сессии** — одна команда `/models` переключает весь функционал.
- **Инструменты (MCP)**: вызываются моделью сессии автоматически — RAG/браузер/
  vision-OCR не привязаны ни к какому LLM-адресу. Своя модель нужна только
  `vision` (для «описания картинки» — `VISION_*`) и `honcho` (см. ниже).

```sh
make set-vision MODEL=qwen3-vl-flash BASE=https://api.minimax.io/v1 KEY=...
```

`configure.sh` пишет:

- `~/.config/opencode/opencode.json` (или `--dir <проект>` — прямо в проект):
  провайдер `local` (llama.cpp) + наши MCP. Модель **не пишется** — opencode
  сам даёт список моделей в `/models`;
- `honcho/.env` — модели для honcho.

По умолчанию `configure.sh` работает в режиме **слияния (merge)**: читает
существующий `opencode.json` и добавляет только недостающее — провайдер
`local`, MCP (`rag`, `honcho`, браузеры, `vision` если задан). Чужие
провайдеры, MCP, агенты, плагины и модель **не трогаются** (не перезатирается
даже `chrome-devtools` со своим путём к Chrome). Полная перегенерация с нуля —
`--force` (затирает чужое!), вообще не трогать файл — `--if-missing`.

## Подстройка под модель

В `stack.config` — только настройки MCP-стеков (шаблон — `stack.config.example`;
сам `stack.config` не в git — там могут быть ключи). Модели и провайдеры тут
**не настраиваются**: модель — в `/models` сессии, удалённые провайдеры —
нативно в opencode:

```sh
# stack.config
LOCAL_LLM_BASE_URL=http://127.0.0.1:1234/v1  # локальная LLM (llama.cpp, если установлена)
LOCAL_LLM_MODEL=local-coder
VISION_MODEL=                         # пусто = vision-mcp выключен
VISION_BASE_URL=
VISION_API_KEY=
HONCHO_LLM_BASE_URL=                  # LLM для honcho (из-за docker: host.docker.internal)
HONCHO_LLM_MODEL=
CHROME_PATH=/usr/bin/google-chrome    # для chrome-devtools MCP
```

## Запуск/остановка стека

**Одна команда поднимает всё установленное** (конфиги opencode + llama/embed/qdrant
+ honcho), идемпотентно — после ребута достаточно:

```sh
make up              # configure.sh → start.sh all → honcho up (всё, что уже установлено)
```

`configure.sh` также ставит глобальный плагин `plugins/honcho-sync.ts` в
`~/.config/opencode/plugins/`. Плагин ведёт память проекта в honcho
(workspace `project-<имя>`):

- **LLM-суммаризация сессий**: когда сессия уходит в idle, плагин вызывает LLM
  (ту же модель, что в сессии, динамически; fallback MiniMax-M3) и пишет в
  honcho одно компактное сообщение `[Summary]` — без потока рассуждений;
- **Инъекция памяти** в system prompt новых сессий — блок `## Honcho Memory`
  строится СЕМАНТИЧЕСКИМ ПОИСКОМ по всему workspace (query = первый
  user-запрос сессии), а не «хвостом» последних сообщений;
- **Инструменты** `honcho_recall` / `honcho_save` / `honcho_sessions` /
  `honcho_memories` регистрируются плагином (MCP-сервер honcho в конфиге
  отключён: `mcp.servers.honcho.disabled: true`).

После обновления плагина перезапусти opencode, чтобы он загрузился.

По шагам (эквивалент):

```sh
make infra           # ./start.sh infra — embed :8095 + qdrant :6333 (без LLM)
./start.sh all       # + main :1234 (только если установлена Gemma)
make honcho          # развернуть honcho (docker, локальная память)
./start.sh health    # статус: 1234 LLM, 8095 embed, 6333 qdrant, 8000 honcho
make down            # остановить стек + honcho (volumes сохраняются)
```

Важно: llama в `./start.sh` слушает **0.0.0.0:1234** (не 127.0.0.1) — иначе
honcho в docker не достанет её через `host.docker.internal`.

Полезное в `start.sh`:

- Автоопределение CUDA-библиотек (pip-пакеты `nvidia/cu13`, системная CUDA);
  переопределить: `LLMSTACK_CUDA_LIB=/path` `./start.sh main`.
- Без GPU `main` не запускается — работай через удалённый провайдер.

## MCP-серверы

Подключаются в `opencode.json` автоматически (`configure.sh`):

| Сервер | Что делает |
|---|---|
| `rag` | поиск по коду **нескольких проектов** (лексика + BM25 + семантика bge-m3). Активный проект определяется по рабочей директории (`cwd` opencode) — где кодим, тот индекс и ищется. Инструменты: `rag_search`, `rag_where`, `rag_summary`, `rag_stats`, `rag_project` (активный + список), `kb_read`, `kb_add` |
| `honcho` | пер-проектная память агента: свой workspace `project-<имя>` и сессии на каждый проект, авто-детект по сессии/`cwd`. Инструменты (от плагина `honcho-sync`): `honcho_sessions`, `honcho_memories`, `honcho_recall` (поиск по памяти), `honcho_save` |
| `vision` | картинки: метаданные, OCR (offline), `describe_image` через любую OpenAI-совместимую vision-модель. Выключен, пока не задан `VISION_MODEL` |
| `chrome-devtools` | браузерная автоматизация (находит Chrome по `CHROME_PATH` в `stack.config`) |
| `playwright` | браузерная автоматизация |

### RAG-индексация (несколько проектов)

Каждый проект индексируется отдельно, в свой каталог (имя — как у папки
проекта, или задаётся `--name`).

**Глобальная команда `rag`** — зашёл в проект, вызвал из любого каталога:

```sh
make install-bin         # один раз: симлинк ~/.local/bin/rag → bin/rag репо

cd ~/myproject
rag index                # 1) индекс текущего каталога (чанки+BM25) 2) вектора в Qdrant
rag search "как делается рассылка"     # поиск → вывод в виде md-таблицы
rag search "биллинг" --top 10          # больше результатов
rag where validateCard                 # где определён символ
rag summary src/api.js                 # сводка по файлу
rag stats                              # чанки/языки/эмбеддинги
rag list                               # какие проекты проиндексированы
rag kb add "факт о проекте"            # дописать в базу знаний
rag index /path/to/other --name api    # или явный путь с алиасом
```

`rag index` делает то же, что старый `rag-index.sh` (скрипт в корне репо):
`build-index.mjs` + `embed.mjs` + список.

Что происходит внутри:

1. `build-index.mjs` — обходит исходники (исключая `node_modules`, `dist`,
   `.git`, бинари), нарезает файлы на чанки (~150 строк с перекрытием),
   кладёт чанки + токены для BM25 + `project.path` (абсолютный путь к
   исходников) в sqlite `rag/projects/<имя>/index.db`;
2. `embed.mjs` — считает эмбеддинги bge-m3 (:8095) и заливает их в **Qdrant**
   (:6333, коллекция `rag_<имя>`), пропуская уже залитые;
3. готово — opencode, запущенный в этом каталоге, сам найдёт проект по
   `project.path` (совпадение рабочей директории), ничего подключать не надо.

То же самое вручную, по шагам:

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

**Как выбирается проект**: MCP-сервер `rag` (и команда `rag`) смотрят на
рабочий каталог — берётся индекс проекта с самым длинным префиксом пути
(глубина вложенности не важна). Так что в разных проектах один и тот же
opencode ищет по своему индексу. Переключение вручную — параметр `project`
любого инструмента (см. `rag_project`), `--project` у `rag search`, или
`RAG_PROJECT=<имя>`.

**Автоматизация через плагин rag-sync**:
- Плагин автоматически ищет релевантные чанки в контекст при первом сообщении сессии и автоматически
  переиндексирует проект по окончании сессии.
- Инструменты теперь доступны через плагин (автопоиск + инструменты + авто-переиндексация).
- MCP-сервер `rag` теперь отключён.

## Honcho (пер-проектная память агента)

Память изолирована **по проектам**: каждому проекту — отдельный workspace
`project-<имя>` со своими сессиями. Активный проект определяется так же, как
у RAG — по рабочей директории (проект = самый длинный префикс пути среди
RAG-индексов, либо ближайший git-репозиторий, либо имя текущей папки).

```sh
make up              # поднимет и honcho (в составе make up) — или отдельно:
make honcho          # ./honcho/setup-honcho.sh: clone plastic-labs/honcho + docker compose up
curl http://127.0.0.1:8000/health   # проверка
```

Характеристики поведения (проверено на локальной Gemma):

- Работа deriver (вывод памяти из сообщений) — **батчами**: диалог обрабатывается,
  когда накопленные сообщения ≥512 токенов ИЛИ прошло 30 минут (`REPRESENTATION_BATCH_*`
  в `~/honcho/.env`). Короткие диалоги висят в очереди до 30 мин — это норма.
- Выводимая память пишется на английском (дефолтные промпты honcho англоязычные).
- `.env` генерирует `configure.sh`; `VECTOR_STORE_TYPE=pgvector` — значение обязано
  совпадать с кодом honcho (не `postgres`).

Инструменты (регистрирует плагин `honcho-sync`, MCP-сервер honcho отключён):

- `honcho_sessions` — сессии текущего проекта;
- `honcho_save` — сохранить факт/заметку в память проекта;
- `honcho_recall` — семантический поиск по памяти проекта («что мы решали
  по поводу биллинга?»);
- `honcho_memories` — сколько сообщений накоплено по каждой сессии.

Плагин сам пишет в память LLM-суммаризации завершённых сессий (той же
моделью, что в сессии; fallback MiniMax-M3 из конфига opencode) и инжектит
релевантную память (`## Honcho Memory`) в system prompt через семантический
поиск по workspace. Следующая сессия агента в том же каталоге подхватит эту
память автоматически.

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

Любые другие модели (кодер, вижн, инструменты) — удалённые провайдеры,
добавляются нативно в opencode (`/providers`, `auth login`, `provider add`);
в `stack.config` для MCP остаются `VISION_*` и `HONCHO_LLM_*`.

## Каталог репозитория

```
setup.sh                 установщик (CUDA, llama.cpp, модели, Qdrant, honcho)
configure.sh             генератор конфигов из stack.config (merge, только MCP + провайдер local)
rag-index.sh             индексация проекта + заливка векторов в Qdrant (как `rag index`)
bin/rag                  глобальная команда `rag` (make install-bin): index/search/where/stats/list/kb
start.sh                 стек-менеджер (all/infra/embed/main/qdrant/stop/health)
Makefile                 обёртки над setup/configure/start; install-bin — глобальный `rag`
stack.config.example     настройки MCP-стеков (vision, honcho, chrome)
agents/                  кастомные агенты (implementer, reviewer)
skills/                  скиллы агентам: auto-tz (ТЗ→оркестрация), subagent-orchestrator, browser-automation
plugins/                 honcho-sync.ts — память в honcho: LLM-суммаризации сессий,
                         семантическая инъекция памяти, инструменты honcho_recall/save
mcp/                     MCP-серверы: rag-server (поиск), honcho-server (память, отключён —
                         инструменты даёт плагин),
                         vision-server; rag-lib.mjs (ядро поиска) + rag-cli.mjs (CLI),
                         build-index.mjs/embed.mjs (индексация)
honcho/                  развёртывание локальной памяти (docker)
qdrant/config.yaml       конфиг Qdrant (:6333, dim 1024)
```

## Скиллы (агентные навыки)

В `skills/` лежат три скилла для opencode (кладутся в `~/.config/opencode/skills/`):

| Скилл | Зачем |
|---|---|
| `auto-tz` | постановка задачи: CLARIFY → PLAN → APPROVE → IMPLEMENT через sub-agent'ов; шаблон `TASK.md` |
| `subagent-orchestrator` | адаптивный пайплайн explore/plan/implement/QA; когда и сколько sub-agent'ов |
| `browser-automation` | авто-проверка UI через chrome-devtools / playwright MCP |

Установка (симлинки, не копии — правки в репо сразу видны агенту):

```sh
make install-skills
```

## FAQ

- **Нет GPU?** `make setup` — только инфраструктура; любую модель выбираешь в
  opencode `/models` (удалённые провайдеры — нативно). Эмбеддинги/RAG работают на CPU.
- **Локальная Gemma?** `make model-gemma` — установка + авто-регистрация провайдера
  `local` с моделью `local/gemma` («Local Gemma 4 12B it»); после этого выбор в `/models`.
- **Хочу другую локальную модель?** Положи GGUF в `models/`, замени
  `LOCAL_LLM_MODEL`/`--alias` в `stack.config` и `start.sh` — модель останется `local/gemma`.
- **Vision?** `make set-vision MODEL=... BASE=... KEY=...` — vision-mcp
  подключится; `describe_image` работает через любую OpenAI-совместимую
  мультимодалку.
- **Несколько проектов?** Индексируй каждый: `rag index /path --name alias`.
  Сервер сам выберет нужный индекс по рабочей директории (`rag list` покажет активный).
- **Модель суб-агента?** Суб-агенты всегда наследуют модель текущей сессии —
  достаточно `rag`-команд и `/models`; отдельная модель агенту не нужна.

Лицензия: MIT.