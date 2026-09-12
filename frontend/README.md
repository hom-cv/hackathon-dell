# Blackbox frontend

The monitoring dashboard is served at `/` by the existing FastAPI application. The inventory application is served at `/inventory` (with `/static/inventory.html` retained as an alias); its search, item creation, and stock editing continue to use `/api/items`.

Both interfaces use local assets and native browser JavaScript. **No frontend build or runtime CDN dependency is required.** Docker Compose's existing static-file setup serves the dashboard automatically. Vendored Lucide icons retain their license in `assets/icons/LICENSE`.

## Run with the application

Follow the root README's Compose setup, then open:

- `http://localhost:8000/` — live monitoring dashboard.
- `http://localhost:8000/?mode=demo` — explicit simulated incident workflow.
- `http://localhost:8000/inventory` — inventory application.

Live mode reads `/api/health` immediately. The current base has no service telemetry or incident controller endpoints: their absence is shown explicitly. Live mode never substitutes demo data. The proposed integration contract and response examples are in [dashboard/API.md](dashboard/API.md).

The dashboard provides overview metrics, latency history with a readable measurement table, incident filtering, chronological tool/action events, metric/log/trace/source-diff evidence, scoped approval/rejection, recovery verification, service details, connection status, and JSON incident export. Polling pauses while the tab is hidden and resumes on return. Observations older than 30 seconds disable decisions.

## Preview without MongoDB

With Node.js 20+ installed, from the repository root:

```sh
node frontend/dashboard/preview.mjs
```

Open `http://127.0.0.1:5173/?mode=demo`. This optional static preview has no backend API and cannot execute real operations. `DASHBOARD_PORT` changes its port. The actual application continues to use FastAPI on port 8000.

## Demo walkthrough

1. Choose **Demo scenarios → Needs approval**. All measurements, source changes, and agent actions are labeled as simulated fixtures.
2. Read the investigation timeline. Open `git.diff` evidence, the correlated trace, and metric evidence.
3. Select **Review & approve rollback**. Confirm the incident revision, recommendation, expected current deployment, and known-good target.
4. Approve. The mock controller moves through rollback (about 4 seconds), verification (about 6 seconds), and resolution. Timing is accelerated for UI demonstration; these are not actual measurement windows.
5. Open **Agent activity** to filter tools/findings/actions or export the selected incident record.
6. Explore **Rejected**, **Rollback failed**, **Verification failed**, **Insufficient recovery samples**, **Stale telemetry**, and **API unavailable**. None falsely report verified recovery.
7. Choose **Healthy / no incidents** to inspect the empty state. Reload or reselect a scenario to reset the in-memory demonstration.

The demo never mutates inventory, local Git, or MongoDB. Live decisions go only to the controller API. API/backend integration and real recovery on GB10 remain dependent on the planned backend implementation.

## Tests

Production has no npm dependencies. Node.js 20+ and the test-only jsdom dependency exercise the rendered UI and contract:

```sh
npm ci --prefix frontend
npm test --prefix frontend
```

The suite covers the approval-to-verification UI, rejection, stale telemetry, unavailable capabilities, evidence rendering, activity filters, idempotent retry/conflict handling, malformed responses, fixture schemas, and preservation of inventory assets. DOM tests do not replace full browser or real MongoDB/GB10 integration testing.

## Files and integration

- `index.html` and `dashboard/` — monitoring console, isolated transport, model validation, chart, fixtures, and integration contract.
- `inventory.html`, `app.js`, `styles.css` — preserved inventory UI.
- `tests/` — DOM interaction and contract tests.
- `dashboard/PLAN.md` — implementation plan for this repository base.

The included UI uses the same origin and needs no CORS change. For a separate frontend origin, configure backend `CORS_ORIGINS` as described in [MongoDB setup](../docs/mongodb-setup.md). Browser requests never contain database credentials.

The backend also serves the dashboard at `/dashboard`. The GB10 deployment script excludes frontend development dependencies and checks the dashboard, inventory page, and dashboard assets after startup. FastAPI routing tests run without MongoDB; database-backed tests still require `MONGODB_TEST_URI`.
