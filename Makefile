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
SKILLS_DIR ?= $(HOME)/.config/opencode/skills

.PHONY: setup models model-gemma config set-vision install-bin install-skills start infra stop health honcho up down clean help

help: ## Показать справку
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

setup: ## Полная установка инфраструктуры (локальная LLM — отдельно: make model-gemma)
	./setup.sh --model $(MODEL) --honcho $(WITH_HONCHO)
	./configure.sh --if-missing

models: ## Скачать модели: bge-m3 (RAG) всегда; Gemma — только с MODEL=gemma
	./setup.sh --model $(MODEL) --skip-llamacpp --skip-qdrant --skip-honcho

model-gemma: ## Установить локальную Gemma 4 12B (отдельная команда) + CUDA-сборка llama.cpp
	./setup.sh --model gemma --backend local --skip-qdrant --skip-honcho --force-llamacpp
	./configure.sh  ## сразу регистрирует провайдер local + модель local/gemma в opencode

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

install-skills: ## Симлинк скиллов репо (auto-tz, subagent-orchestrator, browser-automation) в ~/.config/opencode/skills
	@mkdir -p $(SKILLS_DIR)
	@for s in auto-tz subagent-orchestrator browser-automation; do \
	  if [ -e "$(SKILLS_DIR)/$$s" ]; then \
	    echo "[skip] $$s уже установлен ($(SKILLS_DIR)/$$s)"; \
	  else \
	    ln -s $(CURDIR)/skills/$$s "$(SKILLS_DIR)/$$s" && echo "[ok] $$s -> $(SKILLS_DIR)/$$s"; \
	  fi; \
	done

start: ## Поднять стек (embed :8095, main :1234, qdrant :6333)
	./start.sh all

infra: ## Только инфраструктура без локальной LLM (embed + qdrant) — сценарий «без локальной LLM»
	./start.sh infra

stop: ## Остановить стек
	./start.sh stop

health: ## Статус всех сервисов
	./start.sh health

honcho: ## Развернуть honcho (docker, локальная память на Gemma :1234)
	./configure.sh   ## обновить honcho/.env (адреса моделей) перед деплоем
	./honcho/setup-honcho.sh

up: ## Поднять ВСЁ установленное одной командой (конфиги + стек + honcho). Идемпотентно: после ребута просто `make up`
	./configure.sh
	./start.sh all
	./honcho/setup-honcho.sh

down: ## Остановить стек и honcho (volumes сохраняются — память/данные целы)
	./start.sh stop
	@if [ -d "$(HOME)/honcho" ] && docker compose -f "$(HOME)/honcho/docker-compose.yml" -f "$(HOME)/honcho/docker-compose.override.yml" ps >/dev/null 2>&1; then \
	  cd "$(HOME)/honcho" && docker compose down; \
	fi

clean: ## Удалить собранное/скачанное (модели остаются)
	rm -rf llama.cpp-bin qdrant/qdrant qdrant/storage *.log