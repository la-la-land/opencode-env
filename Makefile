# opencode-env — воспроизводимое окружение для агентной разработки
# (opencode + локальный стек: эмбеддинги llama.cpp, Qdrant, honcho).
#
# Локальной LLM в проекте нет: стек даёт только эмбеддинги (RAG) и память
# (honcho). Модель для агентов выбирается прямо в opencode (/models) —
# суб-агенты её наследуют. Удалённые провайдеры добавляются нативно
# (opencode /providers, auth login, provider add).
#
# Главный сценарий после переустановки ОС:
#   make setup EMBED_MODEL=minilm WITH_HONCHO=1
#   make up
#
# Переменные:
#   EMBED_MODEL=bge-m3|minilm   векторная модель (bge-m3 — качественнее,
#                                minilm — для маломощных ПК)
#   WITH_HONCHO=0|1             разворачивать ли память honcho (docker)

EMBED_MODEL  ?= bge-m3
WITH_HONCHO  ?= 0
BIN_DIR      ?= $(HOME)/.local/bin
SKILLS_DIR   ?= $(HOME)/.config/opencode/skills
CONFIG_DIR   ?= $(HOME)/.config/opencode

.PHONY: help setup models config set-vision install-bin install-skills \
        start infra stop health honcho up down clean

help: ## Показать справку по целям
	@echo "opencode-env — доступные цели:"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'
	@echo
	@echo "Примеры:"
	@echo "  make setup EMBED_MODEL=minilm WITH_HONCHO=1   # установка после переустановки ОС"
	@echo "  make up                                       # поднять стек + honcho (после ребута)"
	@echo "  make set-vision VISION_MODEL=MiniMax-M3 VISION_BASE_URL=https://api.minimax.io/v1 VISION_API_KEY=sk-..."

setup: ## Полная установка окружения (llama.cpp, embed-модель, Qdrant, MCP, симлинки)
	./setup.sh --embed-model $(EMBED_MODEL) --honcho $(WITH_HONCHO)

models: ## Скачать embed-модель (EMBED_MODEL=bge-m3|minilm) и обновить stack.config
	./setup.sh --embed-model $(EMBED_MODEL) --skip-llamacpp --skip-qdrant --skip-honcho \
	           --skip-npm --skip-playwright --skip-config

config: ## Перегенерировать конфиги из stack.config (opencode.json, honcho/.env, плагины)
	./configure.sh

set-vision: ## Включить vision-MCP: make set-vision VISION_MODEL=... VISION_BASE_URL=... VISION_API_KEY=...
	./configure.sh set-vision $(or $(VISION_MODEL),$(MODEL)) $(or $(VISION_BASE_URL),$(BASE)) $(or $(VISION_API_KEY),$(KEY))

install-bin: ## Глобальная команда rag → $(BIN_DIR)/rag
	./setup.sh --only-links

install-skills: ## Симлинки скиллов репо (auto-tz, subagent-orchestrator, browser-automation) в $(SKILLS_DIR)
	./setup.sh --only-links

start: ## Поднять стек (embed :8095 + qdrant :6333)
	./start.sh all

infra: ## Поднять только инфраструктуру (embed + qdrant)
	./start.sh infra

stop: ## Остановить стек (llama.cpp + qdrant)
	./start.sh stop

health: ## Статус сервисов (:8095, :6333, :8000)
	./start.sh health

honcho: ## Обновить honcho/.env и перезапустить honcho (docker)
	./configure.sh
	./honcho/setup-honcho.sh

up: ## Поднять всё установленное (конфиги + стек + honcho). Идемпотентно: после ребута просто make up
	./configure.sh
	./start.sh all
	@if command -v docker >/dev/null 2>&1; then \
		./honcho/setup-honcho.sh || echo "[warn] honcho не поднялся — смотри: cd ~/honcho && docker compose logs api"; \
	else \
		echo "[warn] docker не найден — honcho пропущен"; \
	fi

down: ## Остановить стек и honcho (volumes сохраняются — память и данные целы)
	./start.sh stop
	@if [ -d "$(HOME)/honcho" ] && docker compose -f "$(HOME)/honcho/docker-compose.yml" \
	     -f "$(HOME)/honcho/docker-compose.override.yml" ps >/dev/null 2>&1; then \
		cd "$(HOME)/honcho" && docker compose down; \
	fi

clean: ## Удалить собранное/скачанное бинари и логи (данные Qdrant остаются; CLEAN_DATA=1 — удалить и их)
	rm -rf llama.cpp-bin llama.cpp/build qdrant/qdrant *.log rag/*.log
	@if [ "$(CLEAN_DATA)" = "1" ]; then rm -rf qdrant/storage; echo "[ ok ] данные Qdrant удалены"; fi
