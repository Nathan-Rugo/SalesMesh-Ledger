# SalesMesh Ledger

SalesMesh Ledger handles commission and escrow payments for independent sales agents. An agent collects a customer payment through M-Pesa (Safaricom Daraja STK Push). The gateway records it and asks the ML risk engine to score it. Based on that score, the payment is held in escrow for a risk-adjusted period, quarantined, or cleared. Every escrow decision, fraud lock and payout is also written to a Hyperledger Fabric ledger shared by a merchant org and an auditor org, and a payout is only paid after the ledger authorises it. Agents and admins use an installable web app (PWA). The project is a BSc capstone at Strathmore University.

## Architecture

| Component | Path | Stack |
|---|---|---|
| Gateway | `backend/gateway` | Node.js, TypeScript, Express, Postgres 16, Redis 7 |
| ML risk engine | `ml-engine` | Python 3.11, FastAPI, Isolation Forest followed by calibrated XGBoost, SHAP |
| Commission ledger | `blockchain` | Hyperledger Fabric 2.5.16, Fabric CA 1.5.22, Go chaincode |
| PWA | `frontend` | Next.js 16, React 19, Tailwind v4 |
| Infrastructure | `infra` | Docker Compose, Caddy, Postgres DDL and migrations, deploy scripts |

Caddy serves the PWA and `/api/*` on one HTTPS origin. The gateway calls the ML engine over HTTP (`/evaluate`) and the merchant peer over mTLS gRPC. Only Caddy publishes ports.

Design documents:

- [docs/architecture/deployment.md](docs/architecture/deployment.md): topology, memory budget, secrets map and the EC2 runbook
- [docs/architecture/fabric-testnet.md](docs/architecture/fabric-testnet.md): the Fabric network, identities and policies
- [docs/architecture/commission-chaincode.md](docs/architecture/commission-chaincode.md): chaincode functions, roles and error codes
- [docs/architecture/ledger-sync.md](docs/architecture/ledger-sync.md): how the gateway writes to the ledger and gates payouts
- [docs/operations/reconciliation.md](docs/operations/reconciliation.md) and [docs/operations/trust-and-escrow-holds.md](docs/operations/trust-and-escrow-holds.md)
- [docs/compliance/data-retention.md](docs/compliance/data-retention.md) and [docs/compliance/pii-hmac-key-rotation.md](docs/compliance/pii-hmac-key-rotation.md)
- [docs/testing/stress-and-chaos.md](docs/testing/stress-and-chaos.md)
- [ml-engine/README.md](ml-engine/README.md) and [frontend/README.md](frontend/README.md)

## Prerequisites

- Docker Engine with the compose plugin. All services, including Fabric, run in containers.
- Bash and `openssl` for the scripts in `infra/scripts` and `blockchain/network/scripts`.
- Node 24 on the host for the gateway tests and `make fabric-ledger-e2e` (`infra/scripts/deploy/bootstrap_vm.sh` installs it). The PWA needs Node 22.12 or later. The container images pin their own Node versions.
- Python 3.11 for the ML engine (`requires-python = "~=3.11"` in `ml-engine/pyproject.toml`). The ML engine README uses `uv` to build the venv.
- Go 1.27 for the chaincode unit tests (the version CI uses).
- GNU Make, if you want the `make` shortcuts. Each target is a plain shell command you can run directly.

## Quick start (local stack)

This runs Postgres, Redis, the ML engine, the gateway, the PWA and Caddy on one machine, without Fabric and without payouts.

```bash
bash infra/scripts/deploy/gen_env.sh localhost
docker compose --env-file .env -f infra/docker-compose.yml up -d --build    # same as: make up
docker compose --env-file .env -f infra/docker-compose.yml ps
```

`gen_env.sh` writes the root `.env` (mode 600) from `.env.example`. It fills every secret with random values and creates an RS256 JWT key in `backend/gateway/keys/`. It refuses to overwrite an existing `.env` unless you pass `--force`. It warns when your uid is not 1000, because the gateway container runs as uid 1000 and has to read the JWT key.

Before starting, open `.env` and either enter your Daraja sandbox credentials (`DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_PASSKEY`) or set `STK_ENABLED=false`. Without valid credentials, STK Push requests fail. Africa's Talking is optional. With no username and key, SMS alerts are only logged.

The PWA is then at `https://localhost`. Caddy issues a certificate from its own local CA for `localhost`, so the browser will ask you to accept it. Postgres runs `infra/scripts/init_db.sql` on its first start. Create the first users from inside the gateway container:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec gateway npm run user:create -- \
  --role MERCHANT_ADMIN --name "Ops Admin" --phone 07XXXXXXXX
```

After a `git pull` that adds migrations, run `make migrate`. `make down` stops the stack and `make logs` tails it.

## Running the tests

| Component | Command | Notes |
|---|---|---|
| Gateway | `cd backend/gateway && npm ci && npm test` | On a machine with little RAM, run `npx jest --config jest.config.js --runInBand` instead. Integration suites run only when `TEST_DATABASE_URL` (and `TEST_REDIS_URL`) are set. CI uses `postgres://postgres:pg@localhost:5432/postgres` and `redis://localhost:6379/15`. |
| Gateway checks | `npx tsc --noEmit` and `npm run lint` | Same steps as `.github/workflows/ci-gateway.yml`. |
| Gateway resilience | `npm run test:resilience` | Stress and chaos tier, see [docs/testing/stress-and-chaos.md](docs/testing/stress-and-chaos.md). |
| ML engine | `cd ml-engine && python -m pip install -r requirements-dev.txt && python -m pytest -q` | Use the pinned requirements: the model artifact refuses other scikit-learn or xgboost versions. |
| PWA | `cd frontend && npm ci && npm run typecheck && npm run lint && npm test` | Vitest with `--pool=threads --maxWorkers=2`. |
| Chaincode | `make fabric-chaincode-test` | `go vet` and `go test -race -cover` in `blockchain/chaincode`. |
| Fabric network | `make fabric-smoke` and `make fabric-commission-e2e` | Each creates the testnet, runs its checks and removes it. |
| Gateway and ledger | `cd backend/gateway && npm ci && cd ../.. && make fabric-ledger-e2e` | Runs `blockchain/network/scripts/ledger_e2e.sh`. Expect `LEDGER E2E PASS`. It creates its own network and Postgres, and refuses to run against a network it did not create. |
| Deploy scripts | `bash infra/scripts/deploy/gen_env_test.sh` | Same as `.github/workflows/ci-infra.yml`. |

`make test` runs the ML engine and gateway suites in one go.

## Fabric testnet

`make fabric-up` starts three Fabric CAs, a Raft orderer, a merchant peer and an auditor peer, and creates `commissionchannel`. `make fabric-down` removes the network and its generated crypto. To run the app against it, deploy the chaincode, set `FABRIC_ENABLED=true` and start the stack with the Fabric overlay:

```bash
make fabric-up
bash blockchain/network/scripts/deploy_chaincode.sh commission blockchain/chaincode 1.0 1
sed -i 's/^FABRIC_ENABLED=.*/FABRIC_ENABLED=true/' .env
make deploy-up
docker compose --env-file .env -f infra/docker-compose.yml exec gateway npm run ledger:init
```

Details are in [docs/architecture/fabric-testnet.md](docs/architecture/fabric-testnet.md) and [docs/architecture/ledger-sync.md](docs/architecture/ledger-sync.md).

## Deployment

The demo deployment runs the whole stack on one AWS EC2 VM behind Caddy, with a Let's Encrypt certificate for `<elastic-ip>.sslip.io`. The step-by-step runbook, cost notes, smoke checks and teardown are in [docs/architecture/deployment.md](docs/architecture/deployment.md).

## Configuration

All settings live in the root `.env`, which `gen_env.sh` creates from `.env.example`. The comments in `.env.example` describe every variable. These switch major behaviour:

| Variable | Default | Effect |
|---|---|---|
| `STK_ENABLED` | `true` | Turns on STK Push initiation. The gateway then refuses to start without the Daraja settings. |
| `DARAJA_ENVIRONMENT` | `sandbox` | Daraja environment. Only the sandbox has been used. |
| `FABRIC_ENABLED` | `false` | When `true`, the outbox worker sends to the commission chaincode and every payout claim needs a committed `AuthorisePayout`. When `false`, outbox rows are still written and nothing is sent. |
| `PAYOUTS_ENABLED` | `false` | Turns on verified payout destinations and agent-claimed B2C payouts. Startup then requires the B2C settings. |
| `RECONCILE_ENABLED` | `false` | Turns on Daraja reconciliation (STK Query sweeps). See [docs/operations/reconciliation.md](docs/operations/reconciliation.md). |
| `MODEL_VERSION` | `v1.1.0` | Model version label the gateway records when the ML engine is unreachable and it fails safe to quarantine. Keep it equal to the artifact in `ml-engine/models/`. |
| `MODEL_SHA256` | set by `gen_env.sh` | Pinned digest of the model artifact. The ML engine refuses an artifact that does not match. |
| `AFRICASTALKING_USERNAME`, `AFRICASTALKING_API_KEY` | empty | Optional SMS alerts. The username `sandbox` uses the Africa's Talking sandbox. |

The ML engine's own settings are listed in [ml-engine/README.md](ml-engine/README.md#3-settings), and the PWA's build-time settings in [frontend/README.md](frontend/README.md#environment).

## Release

- Code: `main` at commit `d6da3c9` (merge of PR #78, 2026-11-13).
- ML model: `v1.1.0`, `ml-engine/models/risk_cascade_v1.1.0.joblib`, with its SHA-256 in `risk_cascade_v1.1.0.joblib.sha256`. Its evaluation is reported in [ml-engine/README.md](ml-engine/README.md).

## Repository layout

| Path | Contents |
|---|---|
| `backend/gateway` | Gateway source (`src`), tests (`tests`), Dockerfile and CLI scripts (`npm run user:create`, `ledger:init`, `reconcile:import` and others) |
| `ml-engine` | Risk engine (`engine`), FastAPI service (`service`), tests, model artifacts (`models`), evaluation reports (`reports`) |
| `blockchain/chaincode` | Commission escrow chaincode in Go |
| `blockchain/network` | Fabric testnet config (`configtx`), compose file and scripts (`network_up.sh`, `deploy_chaincode.sh`, `ledger_e2e.sh` and others) |
| `frontend` | Next.js PWA |
| `infra` | `docker-compose.yml`, the Fabric overlay `docker-compose.fabric.yml`, `docker-compose.bench.yml`, the Caddyfile, `init_db.sql`, migrations and deploy scripts |
| `docs` | Architecture, operations, compliance and testing documents, and brand assets |
| `.github/workflows` | CI for the gateway, ML engine, PWA, chaincode and infra, plus a security audit |
| `Makefile` | Shortcuts for the stack, tests and the Fabric testnet (`make help` lists them) |

## Status and limitations

The system has only run against the Safaricom Daraja sandbox and the Africa's Talking sandbox, and no real money has moved through it. Payouts are behind `PAYOUTS_ENABLED`, which is off by default, and the B2C payout flow has not been verified end to end against the sandbox. The Fabric network is a single-host testnet.

## Licence

Copyright (c) 2026 Githinji Nathan Rugo. All rights reserved. The code is published for academic assessment only. See [LICENSE](LICENSE).
