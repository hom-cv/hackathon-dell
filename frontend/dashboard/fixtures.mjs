import { ApiError, SCENARIOS } from './model.mjs';
const evidence = [
  { id: 'ev-metrics', type: 'metric', title: 'Inventory p95 exceeds baseline by 8.4×', source: 'blackbox.metrics · illustrative fixture', content: 'service: inventory\ndeployment_id: dep-bad\nwindow: 10 seconds\np95_latency_ms: 842\nbaseline_p95_ms: 100\nrequest_count: 50\nerror_rate: 0.024\nmean_db_queries: 20\ntelemetry_complete: true' },
  { id: 'ev-trace', type: 'trace', title: '20 sequential database round trips', source: 'trace-demo-042 · checkout → inventory', content: 'POST /checkout                      918 ms\n└── POST /inventory/check            842 ms\n    ├── inventory.find_one           38 ms\n    ├── inventory.find_one           41 ms\n    ├── inventory.find_one           39 ms\n    └── …17 more sequential queries\n\nThe known-good release makes one bulk query.\nDemo round-trip delay is identical across releases.' },
  { id: 'ev-logs', type: 'log', title: 'Slow requests follow the new deployment', source: 'blackbox.logs · inventory · illustrative fixture', content: '[14:32:01] INFO release ready deployment_id=dep-bad\n[14:32:18] WARN inventory duration_ms=817 db_query_count=20\n[14:32:21] WARN inventory duration_ms=861 db_query_count=20\n[14:32:25] WARN checkout error_type=upstream_timeout\n[14:32:30] INFO p95_latency_ms=842 request_count=50' },
  { id: 'ev-diff', type: 'diff', title: 'Bulk lookup replaced by individual queries', source: 'Illustrative Python diff · fixture, not current source', content: '@@ inventory lookup: healthy → regression @@\n- products = list(inventory.find({\n-     "sku": {"$in": skus}\n- }))\n+ products = []\n+ for sku in skus:\n+     product = inventory.find_one({"sku": sku})\n+     products.append(product)\n  return products' },
];
const baseEvents = [
  { type: 'detection', title: 'Critical latency anomaly detected', detail: 'Inventory p95 reached 842 ms. Two complete windows exceeded the critical threshold.', evidence_ids: ['ev-metrics'] },
  { type: 'tool', title: 'Correlated telemetry with the deployment', detail: 'The latency increase follows dep-bad. Checkout is affected downstream.', tool: 'telemetry.query', duration_ms: 124, evidence_ids: ['ev-metrics', 'ev-logs'] },
  { type: 'tool', title: 'Inspected local source changes', detail: 'Compared the active inventory release with its known-good predecessor.', tool: 'git.diff', duration_ms: 48, evidence_ids: ['ev-diff'] },
  { type: 'finding', title: 'Identified an N+1 query regression', detail: 'Twenty sequential database queries replaced one bulk lookup. Trace timing supports the source finding.', evidence_ids: ['ev-trace', 'ev-diff'] },
  { type: 'approval', title: 'Rollback proposed for operator review', detail: 'The agent recommends restoring dep-healthy. Human approval is required before execution.' },
];
export class DemoApi {
  constructor(now = Date.now) { this.now = now; this.setScenario('awaiting_approval'); }
  setScenario(scenario) {
    if (!Object.hasOwn(SCENARIOS, scenario)) throw new ApiError('Unknown demo scenario.', 400);
    this.scenario = scenario; this.started = this.now(); this.decisions = new Map();
    const state = ['stale', 'unavailable'].includes(scenario) ? 'awaiting_approval' : scenario === 'inconclusive' ? 'verification_failed' : scenario;
    if (scenario === 'healthy') { this.current = null; return; }
    const count = state === 'detected' ? 1 : ['investigating', 'investigation_failed'].includes(state) ? 3 : 5;
    const stamp = new Date(this.now()).toISOString();
    this.current = { id: 'INC-0042', title: 'Inventory latency regression', service: 'inventory', severity: 'critical', state, revision: 5,
      observed_at: stamp, created_at: new Date(this.now() - 240000).toISOString(),
      summary: count < 4 ? 'The agent is correlating telemetry with the latest inventory deployment. Root cause has not yet been established.' : 'The latest inventory release replaced a bulk product lookup with sequential queries. Extra database round trips explain the latency spike and downstream checkout degradation.',
      timeline: baseEvents.slice(0, count).map((e, n) => ({ ...e, id: `event-${n + 1}`, timestamp: new Date(this.now() - (240 - n * 35) * 1000).toISOString() })), evidence: structuredClone(evidence),
    };
    if (count === 5) this.current.recommendation = { id: 'rec-0042-1', action: 'rollback', service: 'inventory', expected_deployment_id: 'dep-bad', target_deployment_id: 'dep-healthy', reason: 'Restore the known-good bulk query implementation. No database migration or data change is required.', evidence_ids: ['ev-metrics', 'ev-trace', 'ev-diff'] };
    if (['rolling_back', 'verifying', 'resolved', 'action_failed', 'verification_failed'].includes(state)) {
      this.event('approval', 'Rollback approved by operator', 'Policy gate accepted the scoped recommendation.');
      this.current.action = { status: state === 'rolling_back' ? 'running' : state === 'action_failed' ? 'failed' : 'succeeded', detail: state === 'action_failed' ? 'Active deployment did not match the expected release. No release was changed.' : state === 'rolling_back' ? 'Restoring the known-good inventory artifact.' : 'Known-good artifact is active as deployment dep-recovered.' };
      this.event('action', state === 'action_failed' ? 'Rollback failed' : state === 'rolling_back' ? 'Executing approved rollback' : 'Rollback completed', this.current.action.detail);
    }
    if (['verifying', 'resolved', 'verification_failed'].includes(state)) {
      this.current.verification = { status: state === 'resolved' ? 'healthy' : state === 'verifying' ? 'pending' : scenario === 'inconclusive' ? 'inconclusive' : 'failed', before_p95_ms: 842, after_p95_ms: state === 'resolved' ? 96 : state === 'verification_failed' && scenario !== 'inconclusive' ? 624 : null,
        sample_count: state === 'resolved' ? 300 : 28, windows: state === 'resolved' ? 3 : 1,
        detail: state === 'resolved' ? 'Both services passed three complete post-rollback windows, with at least 30 samples per window. Inventory samples belong to dep-recovered.' : state === 'verifying' ? 'Collecting three complete post-rollback windows for both services.' : scenario === 'inconclusive' ? 'Insufficient fresh samples before the verification deadline. The incident remains open.' : 'Latency remains above the recovery threshold. The incident remains open.' };
      this.event('verification', state === 'resolved' ? 'Recovery verified' : state === 'verifying' ? 'Verifying recovery' : 'Recovery not verified', this.current.verification.detail);
    }
    if (state === 'rejected') this.event('approval', 'Rollback rejected by operator', 'No action was requested. Manual follow-up is required.');
    if (state === 'investigation_failed') this.event('finding', 'Investigation could not complete', 'The local model is unavailable. No recommendation was produced.');
  }
  event(type, title, detail) { this.current.timeline.push({ id: `event-${this.current.timeline.length + 1}`, timestamp: new Date(this.now()).toISOString(), type, title, detail }); }
  tick() {
    if (this.scenario === 'unavailable') throw new ApiError('Demo controller is unavailable. Choose another scenario to reconnect.', 503);
    if (!this.current) return;
    if (this.current.state === 'rolling_back' && this.now() - this.started >= 4000) {
      this.current.state = 'verifying'; this.current.revision++; this.started = this.now();
      this.current.action = { status: 'succeeded', detail: 'Known-good artifact is active as deployment dep-recovered.' };
      this.current.verification = { status: 'pending', detail: 'Collecting three complete post-rollback windows for both services.', before_p95_ms: 842, after_p95_ms: null, sample_count: 0, windows: 0 };
      this.event('action', 'Rollback completed', this.current.action.detail);
      this.event('verification', 'Verifying fresh telemetry', this.current.verification.detail);
    } else if (this.current.state === 'verifying' && this.now() - this.started >= 6000) {
      this.current.state = 'resolved'; this.current.revision++;
      this.current.verification = { status: 'healthy', before_p95_ms: 842, after_p95_ms: 96, sample_count: 300, windows: 3, detail: 'Both services passed three complete post-rollback windows, with at least 30 samples per window. Inventory samples belong to dep-recovered.' };
      this.event('verification', 'Recovery verified', this.current.verification.detail);
    }
    this.current.observed_at = new Date(this.now() - (this.scenario === 'stale' ? 120000 : 0)).toISOString();
  }
  async health() { this.tick(); return { status: 'ok', database: 'connected', agent: 'simulated' }; }
  async services() {
    this.tick(); const recovered = !this.current || this.current.state === 'resolved';
    return ['inventory', 'checkout'].map((id, index) => ({ id, name: index ? 'Checkout' : 'Inventory', status: recovered ? 'healthy' : 'degraded',
      deployment_id: index ? 'checkout-stable' : recovered ? 'dep-recovered' : this.current?.action?.status === 'succeeded' ? 'dep-recovered' : 'dep-bad',
      observed_at: new Date(this.now() - (this.scenario === 'stale' ? 120000 : 0)).toISOString(),
      metrics: { p95_latency_ms: recovered ? index ? 124 : 96 : index ? 918 : 842, error_rate: recovered ? 0 : index ? 0.031 : 0.024, request_count: 50 }, baseline_p95_ms: index ? 130 : 100,
      history: Array.from({ length: 30 }, (_, n) => ({ timestamp: new Date(this.now() - (29 - n) * 60000).toISOString(), p95_latency_ms: n < 13 || this.scenario === 'healthy' || recovered && n > 23 ? 96 + index * 28 + Math.round(Math.sin(n) * 9) : 540 + index * 72 + Math.round(n * 10 + Math.sin(n * 2) * 50) })),
    })).map(s => ({ ...s, deployment_id: this.scenario === 'healthy' && s.id === 'inventory' ? 'dep-healthy' : s.deployment_id }));
  }
  async incidents() { this.tick(); return this.current ? [structuredClone(this.current)] : []; }
  async incident(id) { this.tick(); if (id !== this.current?.id) throw new ApiError('Incident not found.', 404); return structuredClone(this.current); }
  async decide(id, decision, payload) {
    this.tick();
    if (!['approve', 'reject'].includes(decision) || !payload.idempotency_key) throw new ApiError('Invalid decision or missing idempotency key.', 400);
    const signature = JSON.stringify({ id, decision, recommendation_id: payload.recommendation_id, incident_revision: payload.incident_revision });
    const previous = this.decisions.get(payload.idempotency_key);
    if (previous) { if (previous.signature !== signature) throw new ApiError('Idempotency key already used for another decision.', 409); return structuredClone(previous.incident); }
    if (id !== this.current?.id) throw new ApiError('Incident not found.', 404);
    if (this.scenario === 'stale') throw new ApiError('Telemetry is stale. Wait for fresh data.', 409);
    if (this.current.state !== 'awaiting_approval' || this.current.revision !== payload.incident_revision || this.current.recommendation?.id !== payload.recommendation_id) throw new ApiError('Recommendation changed. Review the latest incident before deciding.', 409);
    this.current.state = decision === 'approve' ? 'rolling_back' : 'rejected'; this.current.revision++; this.started = this.now();
    this.event('approval', decision === 'approve' ? 'Rollback approved by operator' : 'Rollback rejected by operator', decision === 'approve' ? 'Policy gate accepted the reviewed recommendation.' : 'No action was requested. Manual follow-up is required.');
    if (decision === 'approve') { this.current.action = { status: 'running', detail: 'Restoring the known-good inventory artifact.' }; this.event('action', 'Executing approved rollback', 'Checking deployment identity before restoring the known-good release.'); }
    const result = structuredClone(this.current); this.decisions.set(payload.idempotency_key, { signature, incident: result }); return result;
  }
}
