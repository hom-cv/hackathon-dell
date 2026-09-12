# Blackbox — Dell GB10 Hackathon

## Project

Blackbox is a local incident-response assistant for site reliability engineering (SRE), targeting the Dell Pro Max GB10. The planned workflow is **detect → investigate → diagnose → remediate → verify**, keeping AI inference and sensitive operational data local. The demo will introduce an Inventory query regression, investigate its telemetry and Git diff, and roll back after operator approval.

## Implemented so far

- **Backend (`backend/app.py`):** FastAPI and PyMongo inventory API. Lists and creates items, updates stock, and exposes database health at `/api/health` and `/healthz`. Validates input, normalizes SKUs, handles duplicates and database failures, and seeds five items without overwriting edits. Uses `shop.inventory` with a unique SKU index.
- **Frontend (`frontend/`):** Plain HTML, CSS, and JavaScript inventory UI with search, stock filters, summary counts, item creation, stock editing, and connection status. Served by FastAPI at `/`, with assets under `/static`; no frontend build step.
- **Infrastructure:** `compose.yaml` runs MongoDB and the web app with health checks and persistent database storage. `scripts/configure.py` generates `.env` credentials without replacing existing configuration. MongoDB initialization scripts and `scripts/deploy-gb10.sh` support local setup and deployment over SSH.
- **Tests (`backend/tests/test_inventory.py`):** MongoDB integration tests cover persistence across restarts, validation, conflicts, database errors, frontend serving, and explicit CORS origins.

## Still planned

Checkout and bulk inventory-check services, a traffic generator, telemetry and baselines, anomaly detection, local AI investigation, incident orchestration, approval and rollback, recovery verification, and an operations dashboard are not implemented yet. The existing frontend is the inventory demo UI.

`README.md` describes the overall architecture. `docs/person-1-plan.md` and `docs/person-1-spec.md` describe proposed ownership, build order, and integration contracts; their suggested modules and CLI commands are not available yet. Person 1 owns demo infrastructure and measurements, Person 2 owns AI investigation, and Person 3 owns incident orchestration and the dashboard.

## Run and validate

From the repository root, with Docker Engine and Compose available:

```sh
python3 scripts/configure.py
docker compose up --build -d --wait
```

Open `http://localhost:8000` for the UI or `/docs` for API documentation. See `docs/mongodb-setup.md` and `backend/README.md` for native Python setup and GB10 deployment.

With a Python virtual environment and a real MongoDB test account authorized to create/drop test databases:

```sh
.venv/bin/python -m pip install -r backend/requirements-dev.txt
MONGODB_TEST_URI='<test-admin-connection-string>' .venv/bin/python -m pytest backend/tests -q
```

Tests use random `blackbox_test_*` databases and skip without `MONGODB_TEST_URI`; skipped tests do not verify database behavior.

## Working conventions

- Keep implementation status distinct from planned architecture; update documentation as features land.
- Keep database credentials server-side and out of version control. The frontend communicates through the API.
- Preserve insert-only seeding so restarts retain inventory changes.
- Keep the MVP focused on one reproducible latency regression. Remediation requires operator approval, and incident resolution requires fresh telemetry confirming recovery.
