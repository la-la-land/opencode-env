# opencode-env — окружение для агентной разработки (opencode + локальный стек)
# Локальная модель: только Gemma 4 12B. Любые другие модели — удалёнными
# провайдерами (opencode.json → providers, ключи из env).
#   BACKEND=local          — локальная Gemma (llama.cpp :1234)
#   BACKEND=remote         — только инфраструктура (RAG/Qdrant/honcho), модель удалённая
#   WITH_HONCHO=0|1        — разворачивать ли honcho (docker)

MODEL     ?= gemma
BACKEND   ?= local
WITH_HONCHO ?= 0

.PHONY: setup models config set-model set-vision set-agent-model start stop health honcho clean help

help: ## Показать справку
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

setup: ## Полная установка окружения
	./setup.sh --model $(MODEL) --backend $(BACKEND) --honcho $(WITH_HONCHO)
	./configure.sh

models: ## Скачать модели (Gemma 4 12B + bge-m3 для RAG)
	./setup.sh --model $(MODEL) --skip-llamacpp --skip-qdrant --skip-honcho

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

stop: ## Остановить стек
	./start.sh stop

health: ## Статус всех сервисов
	./start.sh health

honcho: ## Развернуть honcho (docker) — см. honcho/README.md
	./honcho/setup-honcho.sh

clean: ## Удалить собранное/скачанное (модели остаются)
	rm -rf llama.cpp-bin qdrant/qdrant qdrant/storage *.log