import os
import json

file_path = "/home/leonid/opencode-env/README.md"

# The new block content
new_block = (
    "### RAG-индексация (несколько проектов)\n\n"
    "Каждый проект индексируется отдельно, в свой каталог (имя — как у папки\n"
    "проекта, или задаётся `--name`).\n\n"
    "**Глобальная команда `rag`** — зашёл в проект, вызвал из любого каталога:\n\n"
    "```sh\n"
    "make install-bin         # один раз: симлинк ~/.local/bin/rag → bin/rag репо\n\n"
    "cd ~/myproject\n"
    "rag index                # 1) индекс текущего каталога (чанки+BM25) 2) вектора в Qdrant\n"
    "rag search \"как делается рассылка\"     # поиск → вывод в виде md-таблицы\n"
    "rag search \"биллинг\" --top 10          # больше результатов\n"
    "rag where validateCard                 # где определён символ\n"
    "rag summary src/api.js                 # сводка по файлу\n"
    "rag stats                              # чанки/языки/эмбеддинги\n"
    "rag list                               # какие проекты проиндексированы\n"
    "rag kb add \"факт о проекте\"            # дописать в базу знаний\n"
    "rag index /path/to/other --name api    # или явный путь с алиасом\n"
    "```\n\n"
    "`rag index` делает то же, что старый `rag-index.sh` (скрипт в корне репо):\n"
    "`build-index.mjs` + `embed.mjs` + список.\n\n"
    "Что происходит внутри:\n\n"
    "1. `build-index.mjs` — обходит исходники (исключая `node_modules`, `dist`,\n"
    "   `.git`, бинари), нарезает файлы на чанки (~150 строк с перекрытием),\n"
    "   кладёт чанки + токены для BM25 + `project.path` (абсолютный путь к\n"
    "   исходников) в sqlite `rag/projects/<имя>/index.db`;\n"
    "2. `embed.mjs` — считает эмбеддинги bge-m3 (:8095) и заливает их в **Qdrant**\n"
    "   (:6333, коллекция `rag_<имя>`), пропуская уже залитые;\n"
    "3. готово — opencode, запущенный в этом каталоге, сам найдёт проект по\n"
    "   `project.path` (совпадение рабочей директории), ничего подключать не надо.\n\n"
    "То же самое вручную, по шагам:\n\n"
    "```sh\n"
    "make infra                     # embed :8095 + qdrant :6333 (модель не нужна)\n"
    "# 1) построить индекс проекта (чанки + лексика → sqlite):\n"
    "node mcp/build-index.mjs --project /path/to/project      # имя = имя папки\n"
    "node mcp/build-index.mjs --project /path/to/api --name api\n"
    "node mcp/build-index.mjs --list                          # что уже проиндексировано\n"
    "# 2) залить ВЕКТОРА в Qdrant (bge-m3 :8095): все проекты без эмбеддингов\n"
    "node mcp/embed.mjs\n"
    "node mcp/embed.mjs --project api                         # или только один\n"
    "node mcp/embed.mjs --project api --reset                 # пересоздать коллекцию\n"
    "```\n\n"
    "Хранение разделено: **sqlite** (`rag/projects/<имя>/index.db`) — чанки,\n"
    "токены для BM25, `PROJECT_KNOWLEDGE.md`, `project.path`; **Qdrant** (:6333,\n"
    "коллекция `rag_<имя>`, dim 1024, cosine) — эмбеддинги чанков. Без Qdrant\n"
    "поиск остаётся лексическим (BM25), семантика добавляется автоматически.\n\n"
    "**Как выбирается проект**: MCP-сервер `rag` (и команда `rag`) смотрят на\n"
    "рабочий каталог — берётся индекс проекта с самым длинным префиксом пути\n"
    "(глубина вложенности не важна). Так что в разных проектах один и тот же\n"
    "opencode ищет по своему индексу. Переключение вручную — параметр `project`\n"
    "любого инструмента (см. `rag_project`), `--project` у `rag search`, или\n"
    "`RAG_PROJECT=<имя>`.\n\n"
    "**Автоматизация через плагин rag-sync**:\n"
    "- Плагин автоматически ищет релевантные чанки в контекст при первом сообщении сессии и автоматически\n"
    "  переиндексирует проект по окончании сессии.\n"
    "- Инструменты теперь доступны через плагин (автопоиск + инструменты + авто-переиндексация).\n"
    "- MCP-сервер `rag` теперь отключён.\n"
)

with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1

for i in range(len(lines)):
    if "### RAG-индексация (несколько проектов)" in lines[i]:
        start_idx = i
    if "## Honcho (пер-проектная память агента)" in lines[i]:
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    new_lines = lines[:start_idx] + [new_block + "\n"] + lines[end_idx:]
    with open(file_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)
    print(f"Successfully updated RAG section in {file_path}")
else:
    print("Failed to find RAG section.")
