# Backend

The starter FastAPI app connects to MongoDB and serves the basic frontend from the same origin. It seeds five inventory items and three suppliers using insert-only upserts, so restarting never resets edited stock. Application data uses `shop.inventory` and `shop.suppliers`. Inventory has a unique SKU index, and supplier joins use the indexed supplier `_id`. The application database user also has access to `blackbox` for incident evidence.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Checks an authenticated database read; returns 503 on database failure. |
| GET | `/api/items` | Lists items and supplier details using one indexed `$lookup`, sorted by SKU. |
| POST | `/api/items` | Creates `{sku, name, stock}`; duplicate SKU returns 409. |
| PATCH | `/api/items/{sku}` | Updates `{stock}`; missing SKU returns 404. |
| DELETE | `/api/items/{sku}` | Deletes an item; missing SKU returns 404. Suppliers are retained. |
| GET | `/api/suppliers` | Lists suppliers alphabetically. |
| POST | `/api/suppliers` | Creates a supplier from `{name}`; names are unique ignoring case. |
| GET | `/api/incidents` | Lists incidents for the active run; supports `state` and `limit` filters. |
| GET | `/api/incidents/{id}` | Returns one incident and its supporting evidence for agent handoff. |
| GET | `/api/incidents/{id}/investigations` | Lists structured agent reports for an incident. |
| POST | `/api/incidents/{id}/investigations` | Appends an agent investigation report and updates incident state. |
| GET | `/docs` | Interactive OpenAPI documentation. |

SKU is normalized to uppercase. Stock must be an integer from 0 to 1,000,000. New items may include a valid `supplier_id`. The item dialog lets operators select an existing supplier or type a new supplier name, which creates the supplier before the item. Responses include `created_at` and `updated_at` UTC timestamps and do not expose MongoDB `_id` values.

From the repository root, with a running MongoDB and configured `.env`:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

`MONGODB_URI` overrides the individual `MONGO_*` connection settings. Keep it server-side. Use `CORS_ORIGINS=http://localhost:5173` when connecting a separately served frontend; the included UI needs no CORS configuration.

Each request to `/api/*` or `/healthz` writes one structured completion record to
`blackbox.logs`. The record includes a trace ID (accepting an incoming `X-Trace-ID`),
latency, status, route, deployment metadata, database-query count, and safe query
fingerprint counts, but no request or response body. Writes are buffered outside the timed request path. Configure the
evidence envelope with `DEMO_RUN_ID`, `DEPLOYMENT_ID`, and `GIT_SHA`; tests can set
`TELEMETRY_DATABASE` to isolate records. This is a local OpenTelemetry stand-in, not
a full implementation of OTLP spans, context propagation, sampling, or exporters.

`GET /api/admin/overview` provides the `/admin` dashboard with a read-only summary,
five-minute service health, recent request activity, active-incident count, and
telemetry delivery counters. Observability and health-check requests are persisted
but excluded from workload latency and request-rate calculations.

Generate controlled traffic against the healthy supplier join with:

```sh
python3 scripts/generate-traffic.py --rate 5 --duration 90 --concurrency 10
```

The generator schedules requests at a fixed rate, uses trace IDs, permits concurrent
in-flight work, surfaces missed schedules and failures, and reports mean and p95
client latency. It does not create incidents or mutate application data.

## Incident detection

The background detector builds non-overlapping 10-second windows for successful and
failed `GET /api/items` requests. A window needs at least 30 requests. The first six
consecutive complete windows for a run become its persisted healthy baseline.

An incident is created after two consecutive complete windows exceed either the p95
latency threshold (`max(3 × baseline, 100 ms)`) or the mean database-query threshold
(`max(3 × baseline, baseline + 2)`). Incidents are deduplicated by run, service,
deployment, and rule. Set a fresh `DEMO_RUN_ID`, plus `DEPLOYMENT_ID` and the full
`GIT_SHA`, for each reproducible demo so the eventual investigation can correlate the
incident with its deployment and source diff.

An agent can poll open incidents and then fetch the full evidence document:

```sh
curl --fail 'http://localhost:8000/api/incidents?state=open&limit=20'
curl --fail 'http://localhost:8000/api/incidents/INCIDENT_ID'
```

The collection response contains compact incident summaries and a `handoff_url` for
each result. Use `state=investigating`, `state=diagnosed`, `state=resolved`, or
`state=all` when needed.

Agents append investigation activity and recommendations with:

```sh
curl --fail -X POST \
  -H 'Content-Type: application/json' \
  http://localhost:8000/api/incidents/INCIDENT_ID/investigations \
  --data '{
    "agent_id": "investigator-local",
    "model_name": "local-sre-model",
    "status": "completed",
    "summary": "Correlated the regression with its deployment.",
    "diagnosis": "A lookup inside the item loop caused an N+1 regression.",
    "confidence": 0.98,
    "actions_taken": [
      {"kind": "query_telemetry", "summary": "Compared query counts."},
      {"kind": "inspect_git_diff", "summary": "Inspected the deployment diff."}
    ],
    "evidence": [
      {"kind": "trace", "reference": "TRACE_ID", "summary": "Repeated lookups."}
    ],
    "recommendations": [
      {
        "kind": "rollback",
        "summary": "Roll back the bad join.",
        "rationale": "The previous revision used one indexed lookup.",
        "target": "dep-healthy",
        "requires_operator_approval": true
      }
    ]
  }'
```

Reports intentionally store concise evidence-backed findings rather than private
chain-of-thought or raw model transcripts. They are append-only. A completed report
moves the incident to `diagnosed`; an in-progress report moves it to `investigating`.
Resolved incidents reject new reports. Rollback and code-change recommendations must
retain `requires_operator_approval: true`; this endpoint never executes remediation.

Tests use a real MongoDB and create/drop only randomly named `blackbox_test_*` databases:

```sh
.venv/bin/python -m pip install -r backend/requirements-dev.txt
MONGODB_TEST_URI='<test-admin-connection-string>' .venv/bin/python -m pytest backend/tests -q
```

Use a test account authorized to create and drop those databases. Tests skip without `MONGODB_TEST_URI`; this is not a successful database verification. Full startup and deployment details are in [MongoDB setup](../docs/mongodb-setup.md).
