# Incident Detection Test

This test proves that Blackbox can establish a healthy baseline, detect an N+1
supplier-join regression, create one deduplicated incident, and expose that incident
to an investigation agent.

The test uses real HTTP traffic and persisted MongoDB telemetry. The bad join should
be introduced as a separate Git commit for the final demo. Do not use the temporary
code change below as the permanent implementation.

## Detection rule

The detector evaluates non-overlapping 10-second windows for `GET /api/items`.

- A window requires at least 30 requests.
- Six consecutive complete windows establish the healthy baseline.
- Two consecutive complete regressed windows create an incident.
- A latency regression is p95 latency greater than `max(3 × baseline, 100 ms)`.
- A query regression is mean database queries greater than
  `max(3 × baseline, baseline + 2)`.

The query-count rule makes the test reliable on a fast local MongoDB instance, where
an N+1 join may increase database work substantially without crossing 100 ms.

## Prerequisites

Run commands from the repository root. Docker Engine and Compose must be available,
and `.env` must already exist:

```sh
python3 scripts/configure.py
```

Commit the healthy implementation before starting. The healthy `/api/items` handler
uses one MongoDB `$lookup` and records this query summary:

```json
{
  "db_query_count": 1,
  "db_query_summary": {
    "inventory-with-supplier": 1
  }
}
```

Use a new run ID for every attempt. Reusing an old run can mix earlier telemetry into
the baseline.

## 1. Start the healthy deployment

Replace `join-demo-001` if that run ID has been used before:

```sh
DEMO_RUN_ID=join-demo-001 \
DEPLOYMENT_ID=dep-healthy \
GIT_SHA="$(git rev-parse HEAD)" \
docker compose up --build -d --wait
```

Confirm the API is ready:

```sh
curl --fail http://localhost:8000/api/health
```

## 2. Capture the healthy baseline

Generate 90 seconds of controlled traffic. Ninety seconds provides enough time for
six full windows even when the command starts partway through a 10-second boundary.

```sh
python3 scripts/generate-traffic.py \
  --rate 5 \
  --duration 90 \
  --concurrency 10
```

Confirm that the baseline exists:

```sh
docker compose exec -T mongodb sh -lc \
  'mongosh --quiet \
    --username "$MONGO_INITDB_ROOT_USERNAME" \
    --password "$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase admin \
    --eval '\''printjson(db.getSiblingDB("blackbox").baselines.findOne(
      {demo_run_id:"join-demo-001"},
      {_id:1,sample_count:1,p95_latency_ms:1,mean_db_queries:1,deployment_id:1}
    ))'\'''
```

The healthy `mean_db_queries` should be `1`.

## 3. Introduce the bad join

In `backend/app.py`, replace the healthy `list_items` handler with this N+1 version:

```python
@app.get("/api/items", response_model=list[Item])
def list_items(request: Request):
    items = database_call(
        request,
        "inventory-list",
        lambda: list(
            request.app.state.inventory.find({}, {"_id": 0}).sort("sku", 1)
        ),
    )

    for item in items:
        supplier_id = item.pop("supplier_id", None)
        supplier = None
        if supplier_id:
            document = database_call(
                request,
                "supplier-by-id",
                lambda supplier_id=supplier_id: request.app.state.suppliers.find_one(
                    {"_id": supplier_id},
                    {"normalized_name": 0},
                ),
            )
            if document:
                supplier = {
                    "id": document["_id"],
                    "name": document["name"],
                }
        item["supplier"] = supplier

    return items
```

Commit the bad change so the incident points to a real revision:

```sh
git add backend/app.py
git commit -m "Introduce per-item supplier lookup"
```

## 4. Deploy the bad revision

Keep the same run ID but use a new deployment ID and Git SHA:

```sh
DEMO_RUN_ID=join-demo-001 \
DEPLOYMENT_ID=dep-bad-join \
GIT_SHA="$(git rev-parse HEAD)" \
docker compose up --build -d --wait
```

## 5. Generate degraded traffic

```sh
python3 scripts/generate-traffic.py \
  --rate 5 \
  --duration 40 \
  --concurrency 10
```

Forty seconds provides at least two complete 10-second windows. The detector runs in
the web process every two seconds, so the incident should appear shortly afterward.

## 6. Verify the incident

Open the operations dashboard:

```text
http://localhost:8000/admin
```

The incident should report `database_query_regression`. Its observed mean query count
should be `1 + number of inventory items`, while the baseline should remain `1`.

Query the incident directly from MongoDB if needed:

```sh
docker compose exec -T mongodb sh -lc \
  'mongosh --quiet \
    --username "$MONGO_INITDB_ROOT_USERNAME" \
    --password "$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase admin \
    --eval '\''printjson(db.getSiblingDB("blackbox").incidents.findOne(
      {demo_run_id:"join-demo-001"},
      {_id:0}
    ))'\'''
```

Use the incident's `id` for the read-only agent handoff endpoint:

```sh
curl --fail 'http://localhost:8000/api/incidents?state=open&limit=20'
curl --fail http://localhost:8000/api/incidents/INCIDENT_ID
```

Connect the running NemoClaw sandbox to the handoff and investigation endpoints from
a second host terminal (adjust the API port if this deployment uses another one):

```sh
export BLACKBOX_API_URL=http://127.0.0.1:8000
export NEMOCLAW_SANDBOX_NAME=blackbox-agent
export NEMOCLAW_GATEWAY_PORT=8990

bash scripts/install-nemoclaw-skill.sh
.venv/bin/python -m backend.incident_agent.worker --once
curl --fail http://localhost:8000/api/incidents/INCIDENT_ID/investigations
```

The host worker marks the incident `investigating`, passes only the HTTP handoff
document into NemoClaw, validates the response, and creates the final investigation
through `POST /api/incidents/{id}/investigations`. It does not give the sandbox
MongoDB credentials or remediation access.

Verify deduplication by waiting for more detector evaluations and confirming only one
incident exists for this run, deployment, and rule.

## Expected evidence

A successful test should show:

| Evidence | Healthy | Bad join |
| --- | ---: | ---: |
| Database queries per request | 1 | 1 + inventory item count |
| Response status | 200 | 200 |
| API response shape | Joined supplier data | Same joined supplier data |
| Incident | None | `database_query_regression` |

One verified local run produced a baseline p95 of `7.147 ms`, a baseline query count
of `1`, and a bad query count of `7`. Local latency remained below the absolute
latency threshold, but the deterministic query-regression rule correctly created one
incident after two complete degraded windows. Treat these timings as examples rather
than fixed expectations across machines.

## Restore the healthy version

Restore the healthy join through Git. If the bad change is the latest commit and has
not been shared, create a new revert commit rather than rewriting demo history:

```sh
git revert HEAD
```

Deploy the restored revision with a new deployment identity:

```sh
DEMO_RUN_ID=join-demo-001 \
DEPLOYMENT_ID=dep-recovered \
GIT_SHA="$(git rev-parse HEAD)" \
docker compose up --build -d --wait
```

Incident resolution and automated recovery verification are not implemented yet.
Restoring the healthy code does not automatically mark the incident resolved.

## Optional cleanup

The following permanently removes evidence for only this test run. Replace the run
ID carefully before executing it:

```sh
docker compose exec -T mongodb sh -lc \
  'mongosh --quiet \
    --username "$MONGO_INITDB_ROOT_USERNAME" \
    --password "$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase admin \
    --eval '\''const d=db.getSiblingDB("blackbox");
      const run="join-demo-001";
      printjson({
        logs:d.logs.deleteMany({demo_run_id:run}).deletedCount,
        baselines:d.baselines.deleteMany({demo_run_id:run}).deletedCount,
        incidents:d.incidents.deleteMany({demo_run_id:run}).deletedCount
      })'\'''
```

Do not run cleanup before the investigation agent has collected its evidence.
