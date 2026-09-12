import { ApiError, validateServices, validateSummaries, validateIncident } from './model.mjs';
export class LiveApi {
  constructor({ base = '', fetcher = (...args) => fetch(...args) } = {}) { this.base = base.replace(/\/$/, ''); this.fetcher = fetcher; }
  async request(path, options = {}) {
    const response = await this.fetcher(`${this.base}/api${path}`, {
      ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(8000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = Array.isArray(body?.detail) ? body.detail.map(e => e.msg).join(' ') : body?.detail;
      throw new ApiError(detail || body?.error?.message || body?.message || `Request failed (${response.status}).`, response.status);
    }
    if (!body || typeof body !== 'object') throw new ApiError('API returned an invalid JSON response.', 502);
    return body;
  }
  async health() {
    const health = await this.request('/health');
    if (!['ok', 'ready', 'degraded'].includes(health.status)) throw new ApiError('Invalid health response.', 502);
    return health;
  }
  async services() { return validateServices(await this.request('/services')); }
  async incidents() { return validateSummaries(await this.request('/incidents')); }
  async incident(id) { return validateIncident(await this.request(`/incidents/${encodeURIComponent(id)}`)); }
  async decide(id, decision, payload) {
    if (!['approve', 'reject'].includes(decision)) throw new ApiError('Invalid operator decision.', 400);
    return validateIncident(await this.request(`/incidents/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: JSON.stringify(payload) }));
  }
}
