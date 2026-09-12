# Backend

The starter FastAPI app connects to MongoDB and serves the basic frontend from the same origin. It seeds five inventory items using insert-only upserts, so restarting never resets edited stock. The database is `shop`, collection `inventory`, with a unique SKU index. The application database user also has access to `blackbox` for future incident evidence.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Checks an authenticated database read; returns 503 on database failure. |
| GET | `/api/items` | Lists items sorted by SKU. |
| POST | `/api/items` | Creates `{sku, name, stock}`; duplicate SKU returns 409. |
| PATCH | `/api/items/{sku}` | Updates `{stock}`; missing SKU returns 404. |
| GET | `/docs` | Interactive OpenAPI documentation. |

SKU is normalized to uppercase. Stock must be an integer from 0 to 1,000,000. Responses include `created_at` and `updated_at` UTC timestamps and do not expose MongoDB `_id` values.

From the repository root, with a running MongoDB and configured `.env`:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

`MONGODB_URI` overrides the individual `MONGO_*` connection settings. Keep it server-side. Use `CORS_ORIGINS=http://localhost:5173` when connecting a separately served frontend; the included UI needs no CORS configuration.

Each request to `/api/*` or `/healthz` writes one structured completion record to
`blackbox.logs`. The record includes a trace ID (accepting an incoming `X-Trace-ID`),
latency, status, route, deployment metadata, and database-query count, but no request
or response body. Writes are buffered outside the timed request path. Configure the
evidence envelope with `DEMO_RUN_ID`, `DEPLOYMENT_ID`, and `GIT_SHA`; tests can set
`TELEMETRY_DATABASE` to isolate records. This is a local OpenTelemetry stand-in, not
a full implementation of OTLP spans, context propagation, sampling, or exporters.

`GET /api/admin/overview` provides the `/admin` dashboard with a read-only summary,
five-minute service health, recent request activity, active-incident count, and
telemetry delivery counters. Observability and health-check requests are persisted
but excluded from workload latency and request-rate calculations.

Tests use a real MongoDB and create/drop only randomly named `blackbox_test_*` databases:

```sh
.venv/bin/python -m pip install -r backend/requirements-dev.txt
MONGODB_TEST_URI='<test-admin-connection-string>' .venv/bin/python -m pytest backend/tests -q
```

Use a test account authorized to create and drop those databases. Tests skip without `MONGODB_TEST_URI`; this is not a successful database verification. Full startup and deployment details are in [MongoDB setup](../docs/mongodb-setup.md).
