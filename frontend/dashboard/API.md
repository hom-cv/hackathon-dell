# Dashboard API handoff

This is a **proposed frontend integration contract**, not an implemented incident controller. It follows the README lifecycle and the units/deployment conventions in `docs/person-1-spec.md`. The existing inventory API remains unchanged.

The dashboard uses the same origin and polls every 3 seconds. It treats 404 from `/api/services` or `/api/incidents` as an unavailable capability, independently of the existing health check. Other errors retain the last available snapshot, show the failure, and disable decisions. Invalid response shapes are rejected before rendering. No live request falls back to fixtures.

## Existing endpoint

`GET /api/health` already returns:

```json
{"status":"ok","database":"connected"}
```

This establishes inventory API/database readiness only. It does not establish agent readiness or application latency. `ready` and `degraded` are also accepted status values for future controller integration.

## Proposed monitoring endpoints

| Endpoint | Response |
| --- | --- |
| `GET /api/services` | Array of service records below. Empty array means no reporting services. |
| `GET /api/incidents` | Array of incident summaries: `id`, `title`, `service`, `severity`, `state`, `created_at`. |
| `GET /api/incidents/:id` | Full incident record below. |
| `POST /api/incidents/:id/approve` | Updated full incident after an accepted scoped decision. |
| `POST /api/incidents/:id/reject` | Updated full incident after an accepted scoped decision. |

Arrays are returned directly, without a `data` wrapper. Field names are snake_case. The response is a presentation model; the backend owns translation from MongoDB collections. JSON fixtures implementing these records are in `fixtures.mjs`. Contract validation is in `model.mjs`; transport is isolated in `api.mjs`.

### Service record

```json
{
  "id": "inventory",
  "name": "Inventory",
  "status": "degraded",
  "deployment_id": "dep-bad",
  "observed_at": "2026-09-12T16:00:00Z",
  "metrics": {"p95_latency_ms":842,"error_rate":0.024,"request_count":50},
  "baseline_p95_ms": 100,
  "history": [
    {"timestamp":"2026-09-12T15:59:50Z","p95_latency_ms":817},
    {"timestamp":"2026-09-12T16:00:00Z","p95_latency_ms":842}
  ]
}
```

- Status is `healthy`, `degraded`, or `unknown`.
- Latency uses milliseconds; **error rate is a fraction from 0 to 1**, displayed as a percentage.
- `observed_at` reflects measurement freshness, not browser fetch time. Observations older than 30 seconds, invalid dates, or implausibly future dates are stale. The chart expects history in chronological order.
- Deployment IDs are immutable records, not moving Git branch names. Recovery uses a new rollback deployment ID as specified in Person 1's contract.

### Incident detail

```json
{
  "id":"INC-0042",
  "title":"Inventory latency regression",
  "service":"inventory",
  "severity":"critical",
  "state":"awaiting_approval",
  "revision":5,
  "created_at":"2026-09-12T15:56:00Z",
  "observed_at":"2026-09-12T16:00:00Z",
  "summary":"Sequential queries replaced a bulk lookup.",
  "timeline":[{
    "id":"event-1","timestamp":"2026-09-12T15:58:00Z",
    "type":"tool","title":"Inspected source changes",
    "detail":"Compared active and known-good releases.",
    "tool":"git.diff","duration_ms":48,"evidence_ids":["ev-diff"]
  }],
  "evidence":[{
    "id":"ev-diff","type":"diff","title":"Sequential query regression",
    "source":"repository path and exact source revisions",
    "content":"- bulk query\n+ sequential queries"
  }],
  "recommendation":{
    "id":"rec-0042-1","action":"rollback","service":"inventory",
    "expected_deployment_id":"dep-bad","target_deployment_id":"dep-healthy",
    "reason":"Restore the known-good bulk query implementation.",
    "evidence_ids":["ev-diff"]
  }
}
```

`severity` is `critical` or `warning`. `observed_at` is the controller's last observation of this incident and its decision prerequisites; advance it only when the controller has actually revalidated the snapshot. It is separate from creation or last-event time. The frontend requires a fresh observation for approval, even if the incident was created hours ago.

Timeline event types: `detection`, `tool`, `finding`, `approval`, `action`, `verification`. `tool`, `duration_ms`, and `evidence_ids` are optional. Timeline arrays are chronological. Evidence types: `metric`, `trace`, `log`, `diff`. Content is rendered as escaped text, never as HTML or executed code.

Optional action:

```json
{"status":"succeeded","detail":"Known-good artifact active as dep-recovered."}
```

Action status is `running`, `succeeded`, or `failed`.

Optional verification:

```json
{
  "status":"healthy",
  "before_p95_ms":842,
  "after_p95_ms":96,
  "sample_count":300,
  "windows":3,
  "detail":"Both services passed three complete fresh windows; inventory measurements belong to dep-recovered."
}
```

Verification status is `pending`, `healthy`, `failed`, or `inconclusive`. `after_p95_ms` may be null until fresh measurements are available. `sample_count` is the total evaluated requests; `windows` is the consecutive window count per service. The backend must enforce all completeness, sample-count, deployment-identity, error-rate, and timing requirements in the runtime spec. The frontend rejects `resolved` without a `healthy` verification record; it does not calculate or independently claim recovery.

### Lifecycle

Success: `detected → investigating → awaiting_approval → rolling_back → verifying → resolved`.

Other visible states: `investigation_failed`, `rejected`, `action_failed`, `verification_failed`. Insufficient recovery evidence is `verification_failed` with verification status `inconclusive`; the incident stays open. Backend validation controls transitions.

### Decisions and errors

Both decision endpoints receive only:

```json
{
  "recommendation_id":"rec-0042-1",
  "incident_revision":5,
  "idempotency_key":"operator-generated-uuid"
}
```

The key is in the JSON body, compatible with the current backend's Content-Type CORS allowance. The same reviewed decision reuses the key after a network failure. Concurrent submission is disabled. A 409 closes the review, refreshes the authoritative incident, and requires another operator review.

The controller must atomically validate revision, recommendation, current deployment, policy, and operator authorization before requesting execution. Persist decisions/idempotency keys and reject a reused key with different content. The browser does not send a shell command, target override, or execution request directly.

Errors may use FastAPI `{"detail":"message"}` / validation-detail arrays or `{"error":{"message":"message"}}`. Use 409 for stale/conflicting decisions. Do not execute rollback before approval or return `resolved` solely because deployment succeeded.

## Integration checklist

1. Implement the proposed routes in the incident backend or adapt only `api.mjs` to the agreed controller response.
2. Run the current Compose deployment; open `/` in Live environment mode.
3. Check that real metric windows, deployment IDs, source evidence, and timestamps appear.
4. Rehearse a revision conflict and a repeated request key, then an approved rollback with fresh verification.
5. Disconnect the API and age telemetry past 30 seconds; verify that decisions are disabled.
