# Monitoring dashboard plan

Base: README and docs/person-1-spec.md as pulled on 2026-09-12. The current implementation is a FastAPI/MongoDB inventory application. Detection, agent investigation, and remediation are planned; do not present them as running.

## Implementation

1. Preserve the inventory page at /static/inventory.html, including its existing scripts, styles, and API. Serve the dashboard through the existing root index.html route and static mount, without backend or deployment changes.
2. Implement an offline-capable, dependency-free ES module frontend with graphite surfaces, orange highlights, accessible controls, responsive navigation, service metrics, latency history, incident detail, and the agent activity log.
3. Use the real /api/health response now. Probe proposed /api/services and /api/incidents independently and represent unavailable capabilities explicitly. Never substitute simulated values into live mode.
4. Add opt-in demo fixtures for healthy, investigating, approval, rollback, verification, resolution, and failure states. Mock state owns transitions; UI reads snapshots. Use fractional error rates and UTC timestamps consistent with the current runtime spec.
5. Add evidence/log/trace/diff inspection, filtering, JSON record export, scoped approval/rejection with revision and idempotency key, stale-data safeguards, and authoritative recovery results.
6. Test lifecycle invariants, duplicate/stale decisions, unavailable/invalid APIs, fixture isolation, and deployment paths. Document the proposed API boundary and demo walkthrough.

## Boundaries

Changes stay in frontend/ except documentation in the root README describing entry points and Docker context exclusions for frontend development files. Existing inventory API, MongoDB, Compose, runtime, and agent implementation remain owned by the other worker. No new backend controller is implied by the UI. Live health checks establish inventory API/database readiness only, not application p95 or agent readiness.
