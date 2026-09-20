# opencode-env — окружение для агентной разработки (opencode + локальный стек)
#
# Главный принцип: локальная LLM (Gemma) НЕ ставится по умолчанию.
#   make setup           — инфраструктура (embed bge-m3, Qdrant, honcho опционально)
#   make model-gemma     — ОТДЕЛЬНО, если нужна локальная LLM (GPU)
# Модель для работы берётся из выбранной в opencode-сессии (/models);
# суб-агенты наследуют её (или заданы AGENT_MODEL_* в stack.config).
#   BACKEND=local|remote   — remote: сценарий без локальной LLM
#   WITH_HONCHO=0|1        — разворачивать ли honcho (docker)

MODEL     ?= none
BACKEND   ?= local
WITH_HONCHO ?= 0

.PHONY: setup models model-gemma config set-model set-vision set-agent-model start infra stop health honcho clean help

help: ## Показать справку
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

setup: ## Полная установка инфраструктуры (локальная LLM — отдельно: make model-gemma)
	./setup.sh --model $(MODEL) --backend $(BACKEND) --honcho $(WITH_HONCHO)
	./configure.sh --if-missing

models: ## Скачать модели: bge-m3 (RAG) всегда; Gemma — только с MODEL=gemma
	./setup.sh --model $(MODEL) --skip-llamacpp --skip-qdrant --skip-honcho

model-gemma: ## Установить локальную Gemma 4 12B (отдельная команда) + CUDA-сборка llama.cpp
	./setup.sh --model gemma --backend local --skip-qdrant --skip-honcho --force-llamacpp

config: ## Перегенерировать конфиги из stack.config (opencode.json, honcho/.env)
	./configure.sh

set-model: ## Основная модель: make set-model BACKEND=local|remote MODEL=...
	./configure.sh set-model $(BACKEND) $(MODEL)

set-vision: ## Vision: make set-vision MODEL=... BASE=... KEY=...
	./configure.sh set-vision $(MODEL) $(BASE) $(KEY)

set-agent-model: ## Модель суб-агента: make set-agent-model AGENT=explore MODEL=remote/main
	./configure.sh set-agent-model $(AGENT) $(MODEL)

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