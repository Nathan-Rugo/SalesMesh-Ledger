.PHONY: help up down restart logs ps test test-ml test-gateway seed migrate fabric-up fabric-down fabric-smoke

PG_CONTAINER ?= salesmesh-postgres
PG_USER ?= salesmesh_user
PG_DB ?= salesmesh_db

help:
	@echo "SalesMesh Ledger Monorepo Commands:"
	@echo "  make up          - Start all docker containers (Redis, Postgres, ML, Gateway, PWA)"
	@echo "  make down        - Stop all containers"
	@echo "  make restart     - Restart containers"
	@echo "  make logs        - Tail container logs"
	@echo "  make ps          - View container status"
	@echo "  make test        - Run all unit and integration tests"
	@echo "  make seed        - Run database DDL and initial seeds (fresh database)"
	@echo "  make migrate     - Apply infra/scripts/migrations in order (existing database; applied ones skip)"
	@echo "  make fabric-up   - Start the Fabric testnet (3 CAs, orderer, merchant + auditor peers, commissionchannel)"
	@echo "  make fabric-down - Remove the Fabric testnet and its generated crypto"
	@echo "  make fabric-smoke - Full testnet check: up, deploy, 2-org invoke, query, down"

up:
	docker compose -f infra/docker-compose.yml up -d

down:
	docker compose -f infra/docker-compose.yml down

restart:
	docker compose -f infra/docker-compose.yml restart

logs:
	docker compose -f infra/docker-compose.yml logs -f

ps:
	docker compose -f infra/docker-compose.yml ps

test:
	@echo "Running ML Engine pytest suite..."
	cd ml-engine && pytest
	@echo "Running Gateway tests..."
	cd backend/gateway && npm test

seed:
	docker exec -i $(PG_CONTAINER) psql -U $(PG_USER) -d $(PG_DB) < infra/scripts/init_db.sql

# Each migration is idempotent (schema_migrations guard), so re-running is safe; stops at the first failure.
migrate:
	@for f in infra/scripts/migrations/*.sql; do \
		echo "migrate: $$f"; \
		docker exec -i $(PG_CONTAINER) psql -U $(PG_USER) -d $(PG_DB) -v ON_ERROR_STOP=1 -q < $$f || exit 1; \
	done

fabric-up:
	bash blockchain/network/scripts/network_up.sh

fabric-down:
	bash blockchain/network/scripts/network_down.sh

fabric-smoke:
	bash blockchain/network/scripts/smoke_test.sh
