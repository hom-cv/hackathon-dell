export const STATES = {
  detected: 'Detected', investigating: 'Investigating', awaiting_approval: 'Needs approval',
  rolling_back: 'Rolling back', verifying: 'Verifying recovery', resolved: 'Resolved',
  investigation_failed: 'Investigation failed', rejected: 'Rejected',
  action_failed: 'Rollback failed', verification_failed: 'Verification failed',
};
export const SCENARIOS = { healthy: 'Healthy / no incidents', ...STATES, inconclusive: 'Insufficient recovery samples', stale: 'Stale telemetry', unavailable: 'API unavailable' };
export const STALE_MS = 30000;
export function isStale(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp > now + 5000 || now - timestamp > STALE_MS;
}
export function canDecide(incident, connected, pending = false, now = Date.now()) {
  return Boolean(connected && !pending && incident?.state === 'awaiting_approval'
    && incident.recommendation?.action === 'rollback' && !isStale(incident.observed_at, now));
}
export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
export function statusTone(state) {
  return ['resolved', 'healthy', 'ready', 'ok', 'connected', 'succeeded'].includes(state) ? 'green'
    : state?.includes('failed') || ['critical', 'unavailable'].includes(state) ? 'red'
      : ['unknown', 'rejected', 'not_available'].includes(state) ? 'neutral' : 'amber';
}
export class ApiError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}
const string = value => typeof value === 'string' && value.length > 0;
const number = value => Number.isFinite(value) && value >= 0;
const date = value => string(value) && Number.isFinite(Date.parse(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function requireShape(condition, name) { if (!condition) throw new ApiError(`Invalid ${name} response. Check the dashboard API contract.`, 502); }
export function validateServices(value) {
  requireShape(Array.isArray(value), 'services');
  for (const s of value) {
    requireShape(object(s) && string(s.id) && string(s.name) && ['healthy', 'degraded', 'unknown'].includes(s.status)
      && string(s.deployment_id) && date(s.observed_at) && object(s.metrics)
      && number(s.metrics.p95_latency_ms) && number(s.metrics.error_rate) && s.metrics.error_rate <= 1
      && number(s.metrics.request_count) && number(s.baseline_p95_ms) && Array.isArray(s.history)
      && s.history.every(point => object(point) && date(point.timestamp) && number(point.p95_latency_ms)), 'services');
  }
  return value;
}
export function validateSummaries(value) {
  requireShape(Array.isArray(value), 'incidents');
  for (const i of value) requireShape(object(i) && string(i.id) && string(i.title) && string(i.service)
    && Object.hasOwn(STATES, i.state) && ['critical', 'warning'].includes(i.severity) && date(i.created_at), 'incidents');
  return value;
}
export function validateIncident(i) {
  validateSummaries([i]);
  requireShape(Number.isInteger(i.revision) && i.revision >= 0 && date(i.observed_at) && string(i.summary)
    && Array.isArray(i.timeline) && Array.isArray(i.evidence), 'incident detail');
  for (const e of i.timeline) requireShape(object(e) && string(e.id) && date(e.timestamp) && string(e.title) && string(e.detail)
    && ['detection', 'tool', 'finding', 'approval', 'action', 'verification'].includes(e.type)
    && (!e.evidence_ids || Array.isArray(e.evidence_ids) && e.evidence_ids.every(string)), 'timeline');
  for (const e of i.evidence) requireShape(object(e) && string(e.id) && string(e.title) && string(e.source) && string(e.content)
    && ['metric', 'trace', 'log', 'diff'].includes(e.type), 'evidence');
  if (i.recommendation) {
    const r = i.recommendation;
    requireShape(object(r) && string(r.id) && r.action === 'rollback' && string(r.service)
      && string(r.expected_deployment_id) && string(r.target_deployment_id) && string(r.reason)
      && Array.isArray(r.evidence_ids) && r.evidence_ids.every(id => i.evidence.some(e => e.id === id)), 'recommendation');
  }
  if (i.action) requireShape(['running', 'succeeded', 'failed'].includes(i.action.status) && string(i.action.detail), 'action');
  if (i.verification) requireShape(['pending', 'healthy', 'failed', 'inconclusive'].includes(i.verification.status)
    && string(i.verification.detail) && number(i.verification.before_p95_ms)
    && (i.verification.after_p95_ms == null || number(i.verification.after_p95_ms))
    && number(i.verification.sample_count) && number(i.verification.windows), 'verification');
  requireShape(i.state !== 'resolved' || i.verification?.status === 'healthy', 'verified resolution');
  return i;
}

// randomUUID requires a secure context; getRandomValues also works on a GB10 HTTP origin.
export function decisionKey(provider = globalThis.crypto) {
  if (typeof provider.randomUUID === 'function') return provider.randomUUID();
  const bytes = provider.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
