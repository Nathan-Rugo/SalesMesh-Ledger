.PHONY: help up down restart logs ps deploy-up deploy-down deploy-logs test test-ml test-gateway seed migrate fabric-up fabric-down fabric-smoke fabric-chaincode-test fabric-commission-e2e fabric-ledger-e2e

PG_CONTAINER ?= salesmesh-postgres
PG_USER ?= salesmesh_user
PG_DB ?= salesmesh_db

# The root .env (infra/scripts/deploy/gen_env.sh) feeds compose interpolation and the gateway.
COMPOSE = docker compose --env-file .env -f infra/docker-compose.yml
DEPLOY_COMPOSE = $(COMPOSE) -f infra/docker-compose.fabric.yml

help:
	@echo "SalesMesh Ledger Monorepo Commands:"
	@echo "  make up          - Start the app stack without Fabric (Postgres, Redis, ML, Gateway, PWA, Caddy)"
	@echo "  make down        - Stop all containers"
	@echo "  make restart     - Restart containers"
	@echo "  make logs        - Tail container logs"
	@echo "  make ps          - View container status"
	@echo "  make deploy-up   - Build and start the app stack joined to the Fabric network (docs/architecture/deployment.md)"
	@echo "  make deploy-down - Stop the app stack (volumes kept)"
	@echo "  make deploy-logs - Tail the app stack's logs"
	@echo "  make test        - Run all unit and integration tests"
	@echo "  make seed        - Run database DDL and initial seeds (fresh database)"
	@echo "  make migrate     - Apply infra/scripts/migrations in order (existing database; applied ones skip)"
	@echo "  make fabric-up   - Start the Fabric testnet (3 CAs, orderer, merchant + auditor peers, commissionchannel)"
	@echo "  make fabric-down - Remove the Fabric testnet and its generated crypto"
	@echo "  make fabric-smoke - Full testnet check: up, deploy, 2-org invoke, query, down"
	@echo "  make fabric-chaincode-test - Commission chaincode unit tests (go vet, go test -race -cover)"
	@echo "  make fabric-commission-e2e - Commission chaincode on the testnet: deploy, every function by role, upgrade, down"
	@echo "  make fabric-ledger-e2e - Gateway ledger sync on the testnet: escrow -> commit -> quarantine -> release -> authorise -> settle, peer outage, down"

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

test:
	@echo "Running ML Engine pytest suite..."
	cd ml-engine && pytest
	@echo "Running Gateway tests..."
	cd backend/gateway && npm test

deploy-up:
	$(DEPLOY_COMPOSE) up -d --build

deploy-down:
	$(DEPLOY_COMPOSE) down

deploy-logs:
	$(DEPLOY_COMPOSE) logs -f --tail=200

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

fabric-chaincode-test:
	cd blockchain/chaincode && go vet ./... && go test -race -cover ./...

fabric-commission-e2e:
	bash blockchain/network/scripts/commission_e2e.sh

fabric-ledger-e2e:
	bash blockchain/network/scripts/ledger_e2e.sh
