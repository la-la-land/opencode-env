# opencode-env

Воспроизводимое окружение для **агентной разработки с opencode**: одна папка в
репозитории, из которой ставятся инфраструктура (эмбеддинги / RAG / браузер),
память агента (Honcho), MCP-серверы, плагины и скиллы.

Главный принцип: **в стеке нет локальной LLM**. Модель для работы выбирается
прямо в сессии opencode (`/models`) и наследуется суб-агентами; удалённые
провайдеры добавляются нативно (`/providers`, `auth login`, `provider add`).
Локально крутится только то, что реально нужно каждый день: векторный поиск
по коду и память проекта.

```
llama.cpp (:8095)  ── эмбеддинги для RAG (CPU, без GPU)
Qdrant   (:6333)   ── векторная БД RAG
Honcho   (:8000)   ── память агента (docker), LLM для неё — удалённый провайдер
MCP                ── rag, honcho, chrome-devtools, playwright, vision
Плагины            ── ~/.config/opencode/plugins/{honcho-sync.ts,rag-sync.ts,stats-common.mjs}
Скиллы             ── ~/.config/opencode/skills/{auto-tz,subagent-orchestrator,browser-automation}
```

Всё скачивается/собирается на месте — в git нет ни моделей, ни бинарей.

---

## Требования

| Что | Версия / детали | Зачем |
|---|---|---|
| Linux + `bash` | — | все скрипты репозитория на bash |
| `node` | **>= 20** (нужен встроенный `node:sqlite`) | MCP-серверы, плагины, индекс RAG |
| `python3` | 3.10+ | генерация конфигов (`configure.sh`), tiktoken |
| `curl`, `git` | — | скачивание моделей/бинарей, клонирование |
| `docker` | compose **v2** | только для Honcho (память агента) |
| Chrome / Chromium | путь в `CHROME_PATH` | MCP `chrome-devtools` |
| Диск | **~800 МБ** под качественную embed-модель (bge-m3 Q8_0, 590 МБ) или **126 МБ** под лёгкую | см. «Две векторные модели» |
| RAM | 2 ГБ+ | эмбеддинги считаются на CPU |

GPU не нужен: и эмбеддинги, и RAG, и браузер работают на CPU.

---

## Быстрый старт (новая ОС)

Проверено на чистой машине: `git clone` → одна команда установки → `make up` →
`opencode`.

### 1. Клонируем репозиторий

```sh
git clone https://github.com/la-la-land/opencode-env.git
cd opencode-env
```

### 2. Готовим конфиг

```sh
cp stack.config.example stack.config
```

`stack.config` — единственный файл, который ты правишь руками; сам он **не в
git** (в `.gitignore`), так что ключи туда не попадают.

Минимум, что нужно заполнить:

```sh
# ключ для vision-MCP (описание картинок)
VISION_API_KEY=<ВАШ_КЛЮЧ>
# ключ LLM для Honcho — необязательно: если не задан, setup сам возьмёт
# ключ из базы opencode (cred «MiniMax Token Plan»)
# HONCHO_LLM_API_KEY=<ВАШ_КЛЮЧ>
```

Ключ можно и не писать в файл, а отдать переменной окружения:

```sh
export VISION_API_KEY=<ВАШ_КЛЮЧ>
```

### 3. Установка

```sh
make setup EMBED_MODEL=minilm WITH_HONCHO=1
```

* `EMBED_MODEL=minilm` — лёгкий вариант для слабого ПК; без этой переменной
  ставится модель по умолчанию (качественнее, но больше по размеру) — выбор
  описан в разделе «Две векторные модели».
* `WITH_HONCHO=1` — развернуть память агента в docker. Без него стек поднимется
  без Honcho.

Установщик (`setup.sh`) за один проход:

1. проверяет preflight (node/python3/curl/git, docker — если включён Honcho);
2. ставит npm-зависимости MCP-серверов (`npm ci` в `mcp/` — от этого зависят
   `sharp` и `tesseract.js` для vision);
3. кладёт готовый бинарь `llama.cpp` (`llama-server`) в `llama.cpp-bin/`;
4. скачивает embed-модель в `models/`;
5. ставит Qdrant (tar.gz, без docker);
6. ставит браузер Playwright (`npx -y playwright install chromium`);
7. проверяет Chrome (`CHROME_PATH`) и предупреждает, если его нет;
8. ставит скиллы (симлинки в `~/.config/opencode/skills`) и `rag`
   (симлинк в `~/.local/bin/rag`);
9. разворачивает Honcho (если `WITH_HONCHO=1`);
10. генерирует `~/.config/opencode/opencode.json` и `honcho/.env`
    (`configure.sh`) и печатает статус сервисов.

Скрипт идемпотентный — его можно запускать повторно, он ничего не ломает.

### 4. Запуск стека

```sh
make up
```

`make up` = конфиги opencode + embed `:8095` + Qdrant `:6333` + Honcho `:8000`.
Идемпотентно: **после перезагрузки ОС достаточно `make up`** — всё поднимется
снова.

### 5. Работа в opencode

```sh
opencode
```

* модель сессии — `/models` (удалённый провайдер, `auth login` / `provider add`);
* список MCP — `opencode mcp list` (внутри сессии — `/mcp`);
* агент сразу видит скиллы (`auto-tz`, `subagent-orchestrator`,
  `browser-automation`) и инструменты RAG/Honcho.

---

## Проверка после установки

```sh
# 1) сервисы отвечают (или одной командой: make health)
curl -sf http://127.0.0.1:8095/health  >/dev/null && echo "[ ok ] embed  :8095"
curl -sf http://127.0.0.1:6333/healthz >/dev/null && echo "[ ok ] qdrant :6333"
curl -sf http://127.0.0.1:8000/health  >/dev/null && echo "[ ok ] honcho :8000"

# 2) все MCP-серверы подняты и подключены
opencode mcp list
#   ожидаемо: rag, honcho, chrome-devtools, playwright, vision → connected

# 3) vision: описать картинку (нужен файл png/jpg)
opencode run "опиши картинку ~/Картинки/test.png"
#   агент вызовет vision.describe_image; офлайн-инструменты image_info/ocr_image
#   тоже доступны

# 4) память honcho: сессии и факты по текущему проекту
opencode run "покажи сессии памяти проекта"
#   агент вызовет honcho_sessions / honcho_memories

# 5) RAG: индекс проекта и поиск
cd ~/myproject && rag index && rag search "как делается рассылка"
```

---

## Две векторные модели

Стек работает с любой из двух моделей — размерность векторов у них разная
(1024 и 384). Выбор — на этапе установки и через `stack.config`.

| Модель | Размерность | Размер файла | Pooling | Когда брать |
|---|---|---|---|---|
| **bge-m3** (по умолчанию) | 1024 | 590 МБ (`models/bge-m3-q8_0.gguf`, Q8_0) | `cls` | качество поиска важнее, ПК тянет |
| **MiniLM** (`paraphrase-multilingual-MiniLM-L12-v2`) | 384 | 126 МБ (`models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf`) | `mean` | слабый ПК, мало места, быстрее |

### Как переключить

```sh
# 1) выбрать модель в stack.config (добавить или поменять строку EMBED_MODEL=)
sed -i 's/^EMBED_MODEL=.*/EMBED_MODEL=minilm/' stack.config

# 2) докачать/поставить модель и перегенерировать конфиги
make setup EMBED_MODEL=minilm WITH_HONCHO=1

# 3) перезапустить стек
make up
```

То же флагом установщика: `./setup.sh --embed-model minilm --honcho 1`.
Допустимые значения `--embed-model`: `bge-m3` (качественная) и `minilm` (лёгкая).

Только скачать embed-модель (без остальной установки) — `make models`.

### Важно: размерность фиксируется в коллекциях

Размерность вектора записывается **в коллекции Qdrant** (`rag_<проект>`) и **в
настройках Honcho** (`EMBEDDING_VECTOR_DIMENSIONS`). Поэтому после смены модели
старые коллекции несовместимы с новыми векторами — их надо пересоздать и
проиндексировать заново:

```sh
cd ~/myproject
rag index                       # пересобирает индекс и перезаливает вектора
node mcp/embed.mjs --project myproject --reset   # вариант: пересоздать коллекцию
```

То же для Honcho: `make up` перегенерирует `honcho/.env` с новой размерностью,
но старые записи памяти остаются в базе — при желании пересоздай volume.

### Переменные `stack.config` (единый контракт)

| Переменная | Значения | Смысл |
|---|---|---|
| `EMBED_MODEL` | `bge-m3` \| `minilm` | какая векторная модель используется |
| `EMBED_FILE` | `models/bge-m3-q8_0.gguf` \| `models/paraphrase-multilingual-MiniLM-L12-v2-Q8_0.gguf` | файл в `models/` |
| `EMBED_DIM` | `1024` \| `384` | размерность вектора (в Qdrant и в Honcho) |
| `EMBED_POOLING` | `cls` \| `mean` | pooling llama.cpp для этой модели |
| `EMBED_URL` | https-ссылка | откуда качать файл |
| `VISION_MODEL` | напр. `MiniMax-M3` | пусто = vision выключен |
| `VISION_BASE_URL` | `https://api.minimax.io/v1` | OpenAI-совместимый endpoint |
| `VISION_API_KEY` | ключ | можно задать переменной окружения `VISION_API_KEY` |
| `HONCHO_LLM_BASE_URL` | `https://api.minimax.io/v1` | LLM памяти honcho |
| `HONCHO_LLM_MODEL` | `MiniMax-M3` | модель памяти honcho |
| `HONCHO_LLM_API_KEY` | ключ | пусто = взять из `opencode.db` (cred «MiniMax Token Plan») |
| `CHROME_PATH` | `/usr/bin/google-chrome` | для MCP chrome-devtools |

Дополнительно код читает: `RAG_EMBED_DIM` (размерность для `mcp/embed.mjs`,
дефолт = `EMBED_DIM`), `RAG_EMBED_MODEL`, `RAG_EMBED_URL`, `QDRANT_URL`,
`HONCHO_BASE_URL`, `OPENCODE_CONFIG_DIR`.

---

## Vision — описание картинок

MCP-сервер `vision` умеет: `image_info` (размеры, формат, EXIF, доминирующие
цвета), `ocr_image` (OCR офлайн, `rus+eng`), `describe_image` (описание картинки
мультимодальной моделью через OpenAI-совместимый API).

**Включение** — одним из двух способов:

```sh
# а) через configure.sh (ключ пишется в stack.config)
./configure.sh set-vision MiniMax-M3 https://api.minimax.io/v1 <ВАШ_КЛЮЧ>

# б) через stack.config
VISION_MODEL=MiniMax-M3
VISION_BASE_URL=https://api.minimax.io/v1
VISION_API_KEY=<ВАШ_КЛЮЧ>
```

После правки — `./configure.sh` (или `make config`), затем перезапустить opencode.

**Требования**: npm-зависимости `mcp/` (`sharp` — метаданные и цвета,
`tesseract.js` — OCR). Ставятся установщиком через `npm ci`; если руками:

```sh
cd mcp && npm ci
```

`MiniMax-M3` умеет принимать картинки (запрос уходит в
`/v1/chat/completions` с `image_url` data-URI), так что `describe_image`
работает через любую OpenAI-совместимую мультимодалку.

Пока `VISION_MODEL` пуст — сервер `vision` в `opencode.json` не появляется
(это осознанно: лишний MCP без ключа только шумит в списке).

---

## Браузер: Playwright и chrome-devtools

Два независимых MCP-сервера:

* `playwright` — `npx -y @playwright/mcp@latest`, работает на **chromium**;
  браузер ставится один раз:

  ```sh
  npx -y playwright install chromium
  ```

  (установщик делает это сам, если `~/.cache/ms-playwright` пуст);

* `chrome-devtools` — `npx -y chrome-devtools-mcp@latest`, работает на **системном
  Chrome/Chromium**; путь к нему берётся из `CHROME_PATH`:

  ```sh
  CHROME_PATH=/usr/bin/google-chrome
  ```

  Если Chrome не установлен — установщик предупредит (и поставит руками,
  без `sudo` в неинтерактивных шагах).

---

## Honcho — память агента

Пер-проектная память: каждому проекту — отдельный workspace `project-<имя>`
со своими сессиями. Активный проект определяется по рабочему каталогу (как у
RAG — самый длинный префикс пути среди индексов, ближайший git-репозиторий
или имя текущей папки).

```sh
make honcho           # развернуть (docker)
curl http://127.0.0.1:8000/health
```

`honcho/setup-honcho.sh` клонирует официальный `plastic-labs/honcho` в `~/honcho`
(один раз), копирует туда `.env` (его генерирует `configure.sh`) и
`docker-compose.override.yml`, поднимает контейнеры и ждёт `:8000`.

**LLM для памяти** (deriver / dialectic / summary / dream) — любой
OpenAI-совместимый endpoint:

```sh
HONCHO_LLM_BASE_URL=https://api.minimax.io/v1
HONCHO_LLM_MODEL=MiniMax-M3
HONCHO_LLM_API_KEY=<ВАШ_КЛЮЧ>     # необязательно
```

Если `HONCHO_LLM_API_KEY` пуст, ключ берётся автоматически из базы opencode
(`~/.local/share/opencode/opencode.db`, credential «MiniMax Token Plan») —
скриптом `honcho/fetch-llm-key.sh`. Посмотреть ключ руками:

```sh
./honcho/fetch-llm-key.sh
```

**tiktoken-кэш.** При первом импорте `tiktoken` тянет BPE-файлы с
`openaipublic.blob.core.windows.net`; в некоторых сетях этот домен режется
прокси (TLS-хендшейк зависает без таймаута), и контейнер `honcho-api` не
проходит старт — `/health` не отвечает, MCP honcho таймаутится. Поэтому
`setup-honcho.sh` заранее готовит кэш (`honcho/fetch-tiktoken-cache.sh`):
файлы берутся из репозитория или с HuggingFace, `cl100k_base` пересобирается из
`tokenizer.json`, и всё сверяется по sha256 с официальными `expected_hash` из
`tiktoken`.

Пересобрать кэш вручную (если сеть чинили):

```sh
bash honcho/fetch-tiktoken-cache.sh ~/honcho/.tiktoken-cache
docker compose -f ~/honcho/docker-compose.yml up -d
```

**Инструменты памяти** (регистрирует плагин `honcho-sync`):

| Инструмент | Что делает |
|---|---|
| `honcho_sessions` | сессии текущего проекта |
| `honcho_memories` | сколько сообщений накоплено по каждой сессии |
| `honcho_recall` | семантический поиск по памяти проекта |
| `honcho_save` | сохранить факт/заметку в память проекта |

Плагин `honcho-sync` ещё и **инжектит память в system prompt** новых сессий
(блок `## Honcho Memory` — семантический поиск по всему workspace, query = первый
user-запрос сессии) и пишет в память LLM-суммаризацию завершённых сессий
(одно компактное сообщение `[Summary]`, без потока рассуждений).

Полезно знать: deriver обрабатывает диалог **батчами** — сообщения копятся до
~512 токенов или 30 минут. Короткие диалоги висят в очереди — это нормально.

---

## RAG: индекс и поиск по коду

Поиск идёт по **нескольким проектам** сразу: лексика (BM25) + семантика
(эмбеддинги). Активный проект определяется по рабочей директории opencode —
где кодим, там и ищется.

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

По умолчанию индекс ищется по текущему каталогу; `--project <имя>` (или
`RAG_PROJECT=<имя>`) переключает проект вручную.

По шагам (то же самое делает `rag index`):

```sh
make infra                                  # embed :8095 + qdrant :6333
node mcp/build-index.mjs --project /path/to/project      # имя = имя папки
node mcp/build-index.mjs --project /path/to/api --name api
node mcp/build-index.mjs --list                          # что уже проиндексировано
node mcp/embed.mjs                                       # залить вектора во все проекты
node mcp/embed.mjs --project api                         # или только один
node mcp/embed.mjs --project api --reset                 # пересоздать коллекцию
```

Хранение разделено: **sqlite** (`rag/projects/<имя>/index.db`) — чанки, токены
для BM25, `PROJECT_KNOWLEDGE.md`, `project.path`; **Qdrant** (`:6333`, коллекция
`rag_<имя>`, cosine, размерность = выбранная модель) — эмбеддинги чанков. Без
Qdrant поиск остаётся лексическим (BM25), семантика добавляется автоматически.

Плагин `rag-sync` автоматически подмешивает релевантные чанки в контекст
(блок `## RAG Context`) при первом сообщении сессии и переиндексирует проект
по окончании сессии.

---

## Скиллы и плагины

### Скиллы

В `skills/` лежат три скилла для opencode:

| Скилл | Зачем |
|---|---|
| `auto-tz` | постановка задачи: CLARIFY → PLAN → APPROVE → IMPLEMENT через sub-agent'ов; шаблон `TASK.md` |
| `subagent-orchestrator` | адаптивный пайплайн explore/plan/implement/QA; когда и сколько sub-agent'ов |
| `browser-automation` | авто-проверка UI через chrome-devtools / playwright MCP |

Ставятся **симлинками** в `~/.config/opencode/skills` (правки в репо сразу видны
агенту):

```sh
make install-skills
```

### Плагины

Плагины opencode живут в `~/.config/opencode/plugins/` и **копируются**
(`configure.sh`):

| Плагин | Что делает |
|---|---|
| `honcho-sync.ts` | память проекта в Honcho: LLM-суммаризация сессий, семантическая инъекция `## Honcho Memory`, инструменты `honcho_*` |
| `rag-sync.ts` | автопоиск по индексу + авто-переиндексация, инструменты `rag_*` |
| `stats-common.mjs` | общие счётчики для плагинов |
| `plugins-status/` | TUI-панель со статусом плагинов (`/plugins`) — каталог, ставится в `~/.config/opencode/plugins/` вручную (автоматически не копируется) |

После обновления плагина перезапусти opencode, чтобы он загрузился.

---

## Команды `make`

| Цель | Что делает |
|---|---|
| `make setup [EMBED_MODEL=...] [WITH_HONCHO=1]` | полная установка (llama.cpp, embed-модель, Qdrant, npm, playwright, honcho, конфиги) |
| `make models` | только скачать embed-модель |
| `make config` | перегенерировать `opencode.json` + `honcho/.env` из `stack.config` |
| `make set-vision VISION_MODEL=... VISION_BASE_URL=... VISION_API_KEY=...` | включить vision-MCP |
| `make install-bin` | симлинк `~/.local/bin/rag` → `bin/rag` |
| `make install-skills` | симлинки скиллов в `~/.config/opencode/skills` |
| `make up` | поднять всё установленное: конфиги + embed + qdrant + honcho |
| `make infra` | только embed `:8095` + qdrant `:6333` |
| `make stop` | остановить локальный стек |
| `make down` | остановить стек и honcho (volumes сохраняются) |
| `make health` | статус сервисов (`:8095`, `:6333`, `:8000`) |
| `make honcho` | развернуть/обновить Honcho |
| `make clean` | удалить собранное и скачанное (модели и данные остаются) |
| `make help` | список целей |

Эквивалент вручную: `./setup.sh`, `./configure.sh`, `./start.sh all|infra|embed|qdrant|config|stop|health`,
`./honcho/setup-honcho.sh`.

Флаги `setup.sh` (все опциональны, скрипт идемпотентен):
`--embed-model <имя модели>`, `--honcho 0|1`, `--config-only`, `--only-links`,
`--skip-llamacpp`, `--skip-models`, `--skip-qdrant`, `--skip-honcho`,
`--skip-npm`, `--skip-playwright`, `--skip-config`, `--force-llamacpp`.

---

## Каталог репозитория

```
setup.sh                 установщик (llama.cpp, embed-модель, Qdrant, npm, playwright, honcho, конфиги)
configure.sh             генератор конфигов из stack.config (opencode.json + honcho/.env + плагины)
start.sh                 стек-менеджер (embed :8095, qdrant :6333, stop, health)
Makefile                 обёртки над setup/configure/start (setup, models, up, down, health, help)
stack.config.example     шаблон настроек MCP-стеков — копируется в stack.config
stack.config             локальные настройки с ключами (в .gitignore, в git не попадает)
bin/rag                  глобальная команда `rag` (make install-bin → ~/.local/bin/rag)
rag-index.sh             индексация проекта + вектора в Qdrant (то же, что `rag index`)
mcp/                     MCP-серверы и ядро RAG:
                           rag-server.mjs, honcho-server.mjs, vision-server.mjs,
                           rag-lib.mjs (ядро поиска), rag-cli.mjs (CLI),
                           build-index.mjs + embed.mjs (индексация), package.json
plugins/                 honcho-sync.ts (память в honcho), rag-sync.ts (автопоиск +
                           авто-переиндексация), stats-common.mjs, plugins-status/ (TUI)
skills/                  скиллы агентам: auto-tz, subagent-orchestrator, browser-automation
agents/                  кастомные агенты (implementer.md, reviewer.md)
honcho/                  развёртывание памяти (docker): setup-honcho.sh,
                         fetch-tiktoken-cache.sh, fetch-llm-key.sh, .env.template,
                         docker-compose.override.yml, .tiktoken-cache/
qdrant/                  конфиг Qdrant (:6333) — бинарь и storage не в git
models/                  embed-модели (gguf) — не в git
llama.cpp-bin/           готовый llama.cpp (llama-server) — не в git
rag/                     индексы проектов (sqlite) и логи — не в git
```

---

## Troubleshooting

**Embed не поднялся (`:8095` не отвечает).**

```sh
ls -l llama.cpp-bin/*/llama-server      # бинарь на месте?
ls -l models/*.gguf                     # модель скачалась?
tail -50 rag/embed-server.log            # лог
```

Нет бинаря — переустановить: `make setup`. Нет модели — скачать:
`make models`. Модель и бинарь подбираются по `stack.config`
(`EMBED_FILE`, `EMBED_POOLING`).

**Qdrant не отвечает (`:6333`).**

```sh
tail -50 qdrant/qdrant.log
ls -l qdrant/qdrant                    # бинарь скачан?
```

**Honcho `unhealthy` / `/health` не отвечает.** Почти всегда — tiktoken: сеть
режет `openaipublic.blob.core.windows.net`, контейнер `api` висит на импорте.

```sh
docker compose -f ~/honcho/docker-compose.yml logs api | tail -50
bash honcho/fetch-tiktoken-cache.sh ~/honcho/.tiktoken-cache   # sha256 должен совпасть
docker compose -f ~/honcho/docker-compose.yml up -d
```

Также проверь ключ LLM памяти: `HONCHO_LLM_API_KEY` в `stack.config` или
`./honcho/fetch-llm-key.sh`.

**Vision: `Cannot find package 'sharp'` (или `tesseract.js`).**

```sh
cd mcp && npm ci          # зависимости MCP-серверов
```

После установки пакетов перезапусти opencode.

**MCP-серверы не видны в opencode.**

```sh
opencode mcp list         # список и статус
cat ~/.config/opencode/opencode.json
```

* нет файла → `make config` (или `./configure.sh`);
* сервер есть, но `disabled` → поправь вручную или перегенерируй конфиг;
* `vision` отсутствует — так и задумано, пока не задан `VISION_MODEL`;
* `chrome-devtools`/`playwright` падают — нужен интернет (npx тянет пакеты)
  и установленный браузер (`npx -y playwright install chromium`).

**Порт занят.**

```sh
ss -ltnp | grep -E '8095|6333|8000'
make stop                 # остановить локальный стек
```

**После переустановки ОС всё заново — чек-лист:**

1. `git clone https://github.com/la-la-land/opencode-env.git && cd opencode-env`
2. `cp stack.config.example stack.config` → вписать `VISION_API_KEY` (+ `HONCHO_LLM_API_KEY`, если нужен)
3. `make setup EMBED_MODEL=minilm WITH_HONCHO=1`
4. `make up`
5. `opencode` → `/models` выбрать модель, `opencode mcp list` проверить MCP
6. проиндексировать проекты: `cd ~/myproject && rag index`

---

## FAQ

- **Нет GPU?** Всё равно работает: эмбеддинги и RAG считаются на CPU, модель
  для агента — удалённая (`/models`).
- **Модель для агента?** Любая из `/models`; суб-агенты наследуют модель
  сессии — отдельная модель агенту не нужна.
- **Своя локальная LLM?** Стек её не держит. Модель добавляется как обычный
  OpenAI-совместимый провайдер в opencode (`/providers`, `auth login`,
  `provider add`).
- **Несколько проектов?** Индексируй каждый: `rag index /path --name alias`.
  Активный проект выбирается по рабочему каталогу, `rag list` покажет текущий.
- **Память переехала на другую машину?** Volume honcho живёт в docker — перенеси
  его (`docker volume`) или разверни заново.

Лицензия: MIT.
