# Person 1: Brief Technical Spec

Status: proposed integration contract, version 1. The [implementation plan](person-1-plan.md) defines ownership and build order. Names, interfaces, and thresholds below are planned, not implemented.

## Services and Workload

| Component | Contract |
| --- | --- |
| Checkout | `POST /checkout` accepts `{"items":[{"sku":"sku-001","quantity":1}]}` and returns `{"available":true,"items":[{"sku":"sku-001","quantity":1,"available":true}]}`. Calls Inventory once per request. This demo checks stock without decrementing it. |
| Inventory | `POST /inventory/check` accepts the same body and returns the same availability result. Healthy revision uses one bulk query; bad revision uses sequential queries per distinct SKU. |
| Both services | `GET /healthz` returns service, deployment ID, and full Git SHA; responds 503 when required dependencies are unavailable. Propagate `X-Trace-ID` through Checkout to Inventory. |
| Load generator | Start at 5 requests/second with up to 10 concurrent requests, each containing 20 distinct seeded SKUs. Record failed requests and timeouts; surface missed scheduled requests instead of silently lowering load. |

Seed `shop.inventory` with 100 deterministic SKU documents and a unique `sku` index. Keep data, request mix, and load settings unchanged across healthy, bad, and recovered phases.

## Reproducible Deployment Regression

Use a dedicated local Git fixture repository with two genuine commits. The bad commit changes bulk lookup into repeated individual lookups. Prebuild both immutable Inventory artifacts from those exact revisions; record each full Git SHA and artifact identifier. A configuration toggle alone does not provide the required code-change evidence.

Local database calls may be too fast for a visible demo. Make an explicit fixture option, `DEMO_DB_CALL_DELAY_MS`, simulate database round-trip latency in the shared query adapter. Start at 15 ms per application query, identically configured in both revisions. This changes one delay into 20 delays under the bad query pattern; actual MongoDB queries still execute. Record this setting in run metadata and disclose the simulation in the demo. Telemetry writes do not use this adapter.

Measure actual elapsed time and query counts. Calibrate once on the GB10, then freeze workload and delay settings for the run.

## MongoDB Contract

Person 1 writes the collections below. Every `blackbox` record carries `schema_version: 1`, a string `_id`, and `demo_run_id`. Store timestamps as UTC BSON dates; JSON exports use RFC 3339 UTC strings. Durations are milliseconds, error rates are fractions, and Git SHAs are full hashes. IDs below are illustrative.

| Collection | Required Fields Beyond Common Fields |
| --- | --- |
| `shop.inventory` | Application data, exempt from the evidence envelope: `sku`, `name`, `stock`. |
| `blackbox.runs` | `started_at`, `request_rate`, `items_per_request`, `db_call_delay_ms`, `repo_path`, `healthy_git_sha`, `bad_git_sha`. |
| `blackbox.logs` | `timestamp`, `service`, `deployment_id`, `git_sha`, `trace_id`, `event`, `level`, `duration_ms`, nullable `status_code`, `db_query_count`, nullable `error_type`. One completion record per request; startup/deployment events use the deployment collection. |
| `blackbox.metrics` | `service`, `deployment_id`, `window_start`, `window_end`, `request_count`, `error_count`, `error_rate`, `p95_latency_ms`, `mean_db_queries`, `telemetry_complete`, `dropped_record_count`. Count timeouts as errors and retain their elapsed duration. |
| `blackbox.baselines` | `service`, `deployment_id`, `captured_at`, `metric_ids`, `sample_count`, `p95_latency_ms`, `error_rate`. Freeze before the bad deployment. |
| `blackbox.deployments` | `service`, `git_sha`, `artifact_id`, nullable `previous_deployment_id`, `kind` (`deploy` or `rollback`), `status` (`starting`, `ready`, `failed`), `started_at`, nullable `ready_at`, nullable `action_id`. |
| `blackbox.anomaly_signals` | `service`, `deployment_id`, `rule`, `severity`, `baseline_id`, `metric_ids`, `observed_value`, `threshold`, `timestamp`, `dedup_key`. |
| `blackbox.deployment_operations` | `action_id`, `service`, `expected_deployment_id`, `target_deployment_id`, nullable `result_deployment_id`, `status` (`running`, `succeeded`, `failed`), `started_at`, nullable `finished_at`, nullable `error`. |

Index evidence by `(demo_run_id, service, timestamp/window_end)` as appropriate, and logs by `trace_id`. Enforce uniqueness for operation `action_id`, signal `dedup_key`, and metric `(demo_run_id, service, deployment_id, window_start)`. Keep evidence for the entire demo; do not expire it mid-investigation.

Telemetry records only structured operational fields and uses buffered writes outside the timed request path. Expose write failures and dropped records. Set `telemetry_complete` false for windows with missing, dropped, or unconfirmed records. Incomplete telemetry must prevent baseline capture or a claim of verified recovery.

Person 3 owns `incidents` and `remediation_actions`; Person 2 supplies diagnosis and investigation evidence under their shared contract. `deployment_operations` records low-level execution only, linked through `action_id` to Person 3's approved action.

## Measurement and Detection

- Produce non-overlapping 10-second windows per service and deployment, excluding health checks. Never combine revisions into one window. Use at least 30 completed requests per evaluated window; an undersampled window is inconclusive.
- Before introducing failure, collect six consecutive complete healthy windows per service. Compute baseline p95 from their underlying request samples, not from averaged window percentiles. Use nearest-rank p95 consistently and store source metric IDs.
- Warning: p95 exceeds `max(3 * baseline_p95, 100 ms)` for two consecutive complete windows.
- Critical: p95 exceeds `max(5 * baseline_p95, 250 ms)`, or error rate exceeds `0.10`, for two consecutive complete windows. Emit critical severity when both warning and critical conditions apply.
- Evaluate only finalized windows. Include source evidence IDs and threshold values; key signals by run, service, deployment, rule, and latest window end. Missing or incomplete windows break the consecutive-window streak.
- Both AI detection and the controller read signals. Person 3 consumes critical signals independently of AI availability and deduplicates incidents by run, service, and deployment. Person 2's AI incident path uses the same incident identity.

These are initial demo thresholds. Lock calibrated values before rehearsal and leave baselines unchanged during an incident.

## Deployment and Rollback Interface

Proposed host CLI, run from the demo's installed Python environment:

```sh
python -m blackbox_demo.deploy apply --revision healthy --run-id run-001
python -m blackbox_demo.deploy apply --revision bad --run-id run-001
python -m blackbox_demo.deploy rollback \
  --service inventory \
  --expected-deployment dep-bad \
  --target-deployment dep-healthy \
  --action-id action-001 \
  --run-id run-001
```

The controller invokes the CLI after policy validation and human approval, using argument arrays. Resolve the target through recorded deployments to a prebuilt artifact; accept only known demo services/artifacts. Serialize deployment mutations. Reject a mismatched active deployment, wrong run/service, or a target that never became ready.

Persist the action before mutation and reuse its result on retries. Reusing an action ID with different arguments is a conflict. After interruption, reconcile a running action against the actual artifact and readiness before permitting another change. Create a new deployment ID for rollback so recovery samples remain distinct from the earlier healthy deployment.

Emit exactly one JSON result on stdout, with diagnostics on stderr:

```json
{
  "action_id": "action-001",
  "status": "succeeded",
  "previous_deployment_id": "dep-bad",
  "deployment_id": "dep-recovered",
  "git_sha": "<full-healthy-commit-sha>",
  "ready_at": "2026-09-12T16:00:00Z"
}
```

Exit 0 for successful execution, 2 for invalid input/state conflict, and 1 for execution failure. Failure JSON includes `action_id`, `status: "failed"`, `error_code`, and `message`. Wait up to 30 seconds for readiness and matching revision identity; otherwise record failure. Command success means the artifact is ready, while incident resolution requires the controller's telemetry checks below.

## Recovery and Handoff

Person 3 verifies three consecutive complete windows for both Inventory and Checkout, all starting after rollback readiness, with at least 30 requests each, p95 at or below `max(1.5 * baseline_p95, 50 ms)`, and error rate at or below `0.01`. Inventory metrics must reference the new rollback deployment. Missing data, incomplete telemetry, and readiness alone do not establish recovery. Leave the incident unresolved if verification does not pass within 120 seconds.

Person 1's delivery is accepted when two fresh runs reproduce the latency/query-count regression, expose its true Git diff and correlated logs, and restore the healthy behavior with the rollback command. Supply startup/seed/load/deploy commands, MongoDB connection settings, sample documents, fixture repository path, commit SHAs, and measured thresholds to both teammates.

## Stack References

The proposed API framework is [FastAPI](https://fastapi.tiangolo.com/), MongoDB access uses the official [PyMongo driver](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/), and the local service environment uses [Docker Compose](https://docs.docker.com/compose/). Exact package versions and GB10 compatibility remain implementation checks.
