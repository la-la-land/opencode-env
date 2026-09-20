# opencode-env — окружение для агентной разработки (opencode + локальный стек)
#
# Главный принцип: локальная LLM (Gemma) НЕ ставится по умолчанию.
#   make setup           — инфраструктура (embed bge-m3, Qdrant, honcho опционально)
#   make model-gemma     — ОТДЕЛЬНО, если нужна локальная LLM (GPU)
# Модель не задаётся в конфиге: opencode сам даёт список в /models —
# выбираешь в сессии, суб-агенты наследуют её. Удалённые провайдеры —
# нативно (opencode /providers, auth login, provider add).
#   WITH_HONCHO=0|1        — разворачивать ли honcho (docker)

MODEL     ?= none
WITH_HONCHO ?= 0
BIN_DIR   ?= $(HOME)/.local/bin

.PHONY: setup models model-gemma config set-vision install-bin start infra stop health honcho clean help

help: ## Показать справку
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

setup: ## Полная установка инфраструктуры (локальная LLM — отдельно: make model-gemma)
	./setup.sh --model $(MODEL) --honcho $(WITH_HONCHO)
	./configure.sh --if-missing

models: ## Скачать модели: bge-m3 (RAG) всегда; Gemma — только с MODEL=gemma
	./setup.sh --model $(MODEL) --skip-llamacpp --skip-qdrant --skip-honcho

model-gemma: ## Установить локальную Gemma 4 12B (отдельная команда) + CUDA-сборка llama.cpp
	./setup.sh --model gemma --backend local --skip-qdrant --skip-honcho --force-llamacpp

config: ## Перегенерировать конфиги из stack.config (opencode.json, honcho/.env)
	./configure.sh

set-vision: ## Vision-MCP: make set-vision MODEL=... BASE=... KEY=...
	./configure.sh set-vision $(MODEL) $(BASE) $(KEY)

install-bin: ## Глобальная команда rag → $(BIN_DIR)/rag (проект — по текущему каталогу)
	@mkdir -p $(BIN_DIR)
	ln -sf $(CURDIR)/bin/rag $(BIN_DIR)/rag
	@echo "rag установлен: $(BIN_DIR)/rag"
	@echo "  rag index               — индекс текущего каталога + вектора в Qdrant"
	@echo "  rag search \"запрос\"     — поиск → md-таблица"

start: ## Поднять стек (embed :8095, main :1234, qdrant :6333)
	./start.sh all

infra: ## Только инфраструктура без локальной LLM (embed + qdrant) — сценарий «без локальной LLM»
	./start.sh infra

stop: ## Остановить стек
	./start.sh stop

health: ## Статус всех сервисов
	./start.sh health

honcho: ## Развернуть honcho (docker) — см. honcho/README.md
	./honcho/setup-honcho.sh

clean: ## Удалить собранное/скачанное (модели остаются)
	rm -rf llama.cpp-bin qdrant/qdrant qdrant/storage *.log