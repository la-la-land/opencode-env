#!/usr/bin/env bash
# ============================================================
# rag-index.sh — проиндексировать проект и залить вектора в Qdrant.
#
#   ./rag-index.sh                          # ТЕКУЩИЙ каталог (запуск изнутри проекта)
#   ./rag-index.sh /path/to/project         # указанный проект
#   ./rag-index.sh /path/to/project --name alias   # имя индекса своё
#
# Требует запущенные bge-m3 (:8095) и Qdrant (:6333): make infra.
# После индексации opencode в этом каталоге сам подхватит проект по cwd.
# ============================================================
set -euo pipefail
CALLER_PWD="$(pwd)"            # исходная директория (до перехода в репо)
cd "$(dirname "$0")"
ROOT="$(pwd)"

PROJECT="${1:-$CALLER_PWD}"
shift 2>/dev/null || true

echo "=== 1) индексирую: $PROJECT"
node mcp/build-index.mjs --project "$PROJECT" "$@"
echo "=== 2) заливаю вектора в Qdrant"
node mcp/embed.mjs
echo "=== готово. Проекты:"
node mcp/build-index.mjs --list