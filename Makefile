.PHONY: help up down restart logs ps test test-ml test-gateway seed

help:
	@echo "SalesMesh Ledger Monorepo Commands:"
	@echo "  make up          - Start all docker containers (Redis, Postgres, ML, Gateway, PWA)"
	@echo "  make down        - Stop all containers"
	@echo "  make restart     - Restart containers"
	@echo "  make logs        - Tail container logs"
	@echo "  make ps          - View container status"
	@echo "  make test        - Run all unit and integration tests"
	@echo "  make seed        - Run database DDL and initial seeds"

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
	cd ml-engine && pytest || true
	@echo "Running Gateway tests..."
	cd backend/gateway && npm test || true

seed:
	docker exec -i salesmesh-postgres psql -U salesmesh_user -d salesmesh_db < infra/scripts/init_db.sql