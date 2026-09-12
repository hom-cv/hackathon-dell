# Person 1: Implementation Plan

Status: proposed MVP plan; implementation has not started. See the [brief spec](person-1-spec.md) for contracts and defaults.

## Outcome

Deliver a local Checkout -> Inventory -> MongoDB system that reliably becomes slow after a bad deployment, produces useful evidence, and recovers after rollback. The entire scenario must run independently of the AI and dashboard so teammates can integrate incrementally.

## Ownership

| Owner | Responsibility |
| --- | --- |
| You, Person 1 | Demo services, MongoDB setup and evidence schemas, traffic generator, telemetry, baseline measurement, anomaly signals, deployment and rollback commands. |
| Person 2 | Local model and agent runtime, AI incident detection, evidence retrieval, Git investigation, structured diagnosis and recommendation. |
| Person 3 | Incident lifecycle, duplicate incident handling, critical-signal fallback, policy gate, human approval, invoking rollback, verifying recovery, dashboard. |

You provide the rollback operation and recovery measurements. Person 3 controls execution and decides when an incident can close. Person 2 owns the hackathon's required integration with at least one of OpenClaw, NemoClaw, or OpenShell.

## Proposed Stack

Use Python, FastAPI, PyMongo, an HTTPX traffic generator, Docker Compose, and pytest. Keep the demo package and its dependencies under `backend/demo/`; agree with Person 3 before introducing shared backend configuration. MongoDB runs locally, with separate `shop` and `blackbox` databases. Pin versions and verify container compatibility on the actual GB10 during setup.

## Build Order

| Step | Work | Completion Check |
| --- | --- | --- |
| 1. Publish contracts | Agree on the companion spec, service/deployment IDs, MongoDB connection details, and controller access to the deployment CLI. Provide example evidence documents immediately. | Persons 2 and 3 can develop readers against the same shapes. |
| 2. Healthy system | Start local MongoDB and both services; seed 100 SKUs; implement bulk inventory lookup and a steady traffic generator. | Checkout succeeds, both services report readiness, and the healthy query count is one per inventory request. |
| 3. Evidence and baseline | Add correlated structured logs, 10-second metric windows, deployment records, and a frozen baseline. | A teammate can trace a checkout request to inventory and identify its deployed Git revision. |
| 4. Reproducible regression | Prepare two real commits in a dedicated demo Git repository and prebuild both artifacts. Deploy the revision that replaces the bulk query with sequential lookups. Add warning and critical signals. | The same workload yields 20 queries instead of one and crosses the configured latency threshold. |
| 5. Rollback operation | Implement the bounded rollback CLI, readiness checks, persistent action results, and stale-deployment protection. | An explicit rollback restores the healthy artifact; repeated requests do not redeploy it again. |
| 6. Integrate and rehearse | Connect live evidence to Person 2 and rollback/metrics to Person 3. Run the complete scenario twice with fresh run IDs. | Both runs show healthy state, regression, evidence, approval, rollback, and verified recovery. |

## Suggested Files

All paths below are proposed, not existing commands or modules.

```text
backend/demo/
  pyproject.toml
  compose.yaml
  .env.example
  blackbox_demo/
    checkout.py
    inventory.py
    telemetry.py
    monitor.py
    seed.py
    load.py
    deploy.py
  fixtures/                 # source used to prepare the demo Git history
  tests/
  README.md                 # actual setup and rehearsal commands
```

Keep runtime data, generated artifacts, and the dedicated demo Git checkout in a gitignored runtime directory. Creating demo commits must not change a teammate's working branch. Publish that repository's absolute path and the full healthy/bad commit SHAs to Person 2.

## Early Handoffs

- Person 2 gets sample logs, metrics, signals, baseline and deployment records, plus the actual Git diff, as soon as step 4 works. AI reasoning remains their responsibility.
- Person 3 gets sample records during step 1 and the rollback command contract before its implementation. The demo CLI initially assumes the controller can run a subprocess on the GB10 host.
- Share measured healthy/bad p95 values and calibrated thresholds after rehearsal. Thresholds in the spec are starting values, not promises about hardware performance.

## Acceptance and Scope

Test the meaningful boundaries: equal healthy/bad response data with different query counts; request/deployment correlation; minimum-sample and sustained-window detection; duplicate and stale rollback handling; failed readiness; and recovery using only new telemetry. Prove Person 3's critical-signal path still creates an incident when the AI detector is unavailable.

The MVP uses one reproducible query regression and one rollback operation. Generated code repairs, multiple failure scenarios, a full tracing platform, and production deployment infrastructure are later work.
