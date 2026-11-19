#!/usr/bin/env python3
"""opencode-env / update_readme.py — синхронизация раздела README про RAG.

Скрипт обновляет в README.md канонический раздел «RAG: индекс и поиск по коду».
Путь к README вычисляется **относительно самого скрипта** (os.path.dirname(__file__)),
жёстких абсолютных путей нет — скрипт работает в любом клоне репозитория.

Использование:
    python3 update_readme.py            # обновить README (идемпотентно)
    python3 update_readme.py --check    # только проверить, ничего не писать
    python3 update_readme.py --file X   # указать другой README

Идемпотентность: повторный запуск на актуальном README ничего не меняет
(скрипт печатает «уже актуален» и выходит с кодом 0).
"""
import argparse
import os
import sys

# --- раздел README, который обновляем (маркеры = заголовки) ---
START_HEADING = "## RAG: индекс и поиск по коду"
END_HEADING = "## Скиллы и плагины"

RAG_SECTION = """## RAG: индекс и поиск по коду

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

"""


def default_readme() -> str:
    """README рядом со скриптом (без хардкодных абсолютных путей)."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "README.md")


def find_markers(lines):
    """Индексы строк: начало раздела и следующий заголовок (или None)."""
    start = end = None
    for i, line in enumerate(lines):
        if start is None and line.strip() == START_HEADING:
            start = i
            continue
        if start is not None and line.strip() == END_HEADING:
            end = i
            break
    return start, end


def main() -> int:
    parser = argparse.ArgumentParser(description="Обновить раздел RAG в README.md")
    parser.add_argument("--file", default=None, help="путь к README (по умолчанию — рядом со скриптом)")
    parser.add_argument("--check", action="store_true", help="только проверить, не записывать")
    args = parser.parse_args()

    readme = args.file or default_readme()
    if not os.path.isfile(readme):
        print(f"[fail] README не найден: {readme}")
        return 1

    with open(readme, "r", encoding="utf-8") as f:
        lines = f.readlines()

    start, end = find_markers(lines)
    if start is None or end is None:
        where = "начало" if start is None else "конец"
        print(f"[fail] не найден маркер ({where} раздела): {START_HEADING!r} … {END_HEADING!r}")
        print("       README не тронут — проверь заголовки вручную.")
        return 1

    new_lines = lines[:start] + [RAG_SECTION] + lines[end:]
    old_text = "".join(lines)
    new_text = "".join(new_lines)

    if new_text == old_text:
        print(f"[ ok ] README уже актуален: {readme}")
        return 0

    if args.check:
        print(f"[fail] раздел RAG в {readme} расходится с эталоном (запусти без --check)")
        return 1

    with open(readme, "w", encoding="utf-8") as f:
        f.writelines(new_lines)
    print(f"[ ok ] раздел RAG обновлён: {readme}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
