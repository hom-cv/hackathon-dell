import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoApi } from '../dashboard/fixtures.mjs';
import { LiveApi } from '../dashboard/api.mjs';
import { ApiError, STATES, SCENARIOS, canDecide, decisionKey, isStale, validateServices, validateIncident, escapeHTML } from '../dashboard/model.mjs';
const start = Date.parse('2026-09-12T14:00:00Z');
const payload = { recommendation_id: 'rec-0042-1', incident_revision: 5, idempotency_key: 'operator-1' };
test('approval causes one rollback and requires fresh verification before resolution', async () => {
  let now = start; const api = new DemoApi(() => now);
  assert.equal((await api.incident('INC-0042')).action, undefined);
  const result = await api.decide('INC-0042', 'approve', payload);
  assert.equal(result.state, 'rolling_back');
  assert.deepEqual(await api.decide('INC-0042', 'approve', payload), result);
  assert.equal((await api.incident('INC-0042')).timeline.filter(e => e.type === 'action').length, 1);
  now += 4000; assert.equal((await api.incident('INC-0042')).state, 'verifying');
  now += 5999; assert.equal((await api.incident('INC-0042')).state, 'verifying');
  now++; const recovered = await api.incident('INC-0042');
  assert.equal(recovered.state, 'resolved'); assert.equal(recovered.verification.status, 'healthy');
  assert.equal(recovered.verification.windows, 3); assert.ok(recovered.verification.sample_count >= 180);
  assert.equal((await api.services())[0].deployment_id, 'dep-recovered');
});
test('rejection records the decision without executing a rollback', async () => {
  const api = new DemoApi(() => start); const result = await api.decide('INC-0042', 'reject', payload);
  assert.equal(result.state, 'rejected'); assert.equal(result.action, undefined);
  await assert.rejects(api.decide('INC-0042', 'approve', { ...payload, idempotency_key: 'new' }), /changed/);
});
test('old revisions, wrong recommendations and conflicting key reuse are rejected', async () => {
  const api = new DemoApi(() => start);
  await assert.rejects(api.decide('INC-0042', 'approve', { ...payload, incident_revision: 4 }), /changed/);
  await assert.rejects(api.decide('INC-0042', 'approve', { ...payload, recommendation_id: 'wrong' }), /changed/);
  assert.equal((await api.incident('INC-0042')).action, undefined);
  await api.decide('INC-0042', 'approve', payload);
  await assert.rejects(api.decide('INC-0042', 'reject', payload), error => error instanceof ApiError && error.status === 409);
});
test('stale, invalid, future, disconnected and pending observations disable decisions', async () => {
  const api = new DemoApi(() => start); const incident = await api.incident('INC-0042');
  assert.equal(canDecide(incident, true, false, start), true);
  assert.equal(canDecide(incident, false, false, start), false);
  assert.equal(canDecide(incident, true, true, start), false);
  assert.equal(canDecide(incident, true, false, start + 30001), false);
  assert.equal(isStale('invalid', start), true);
  assert.equal(isStale(new Date(start + 60000).toISOString(), start), true);
  api.setScenario('stale'); await assert.rejects(api.decide('INC-0042', 'approve', payload), /stale/);
});
test('failure and insufficient samples never resolve with elapsed time', async () => {
  let now = start; const api = new DemoApi(() => now);
  for (const scenario of ['verification_failed', 'inconclusive', 'action_failed', 'investigation_failed']) {
    api.setScenario(scenario); now += 300000;
    const incident = await api.incident('INC-0042');
    assert.notEqual(incident.state, 'resolved'); assert.equal(canDecide(incident, true, false, now), false);
  }
});
test('all scenario fixtures satisfy the contract; healthy is empty; errors are explicit', async () => {
  const api = new DemoApi(() => start);
  for (const scenario of Object.keys(SCENARIOS)) {
    api.setScenario(scenario);
    if (scenario === 'unavailable') { await assert.rejects(api.health(), /unavailable/); continue; }
    validateServices(await api.services());
    if (scenario === 'healthy') { assert.deepEqual(await api.incidents(), []); continue; }
    const incident = validateIncident(await api.incident('INC-0042'));
    if (Object.hasOwn(STATES, scenario)) assert.equal(incident.state, scenario);
  }
});
test('live health accepts the existing inventory backend and preserves missing capabilities', async () => {
  const api = new LiveApi({ fetcher: async url => url.endsWith('/health') ? Response.json({ status: 'ok', database: 'connected' }) : Response.json({ detail: 'Not Found' }, { status: 404 }) });
  assert.equal((await api.health()).database, 'connected');
  await assert.rejects(api.services(), error => error instanceof ApiError && error.status === 404);
  await assert.rejects(api.incidents(), error => error instanceof ApiError && error.status === 404);
});
test('live decisions send only the bounded payload to the correct route', async () => {
  const demo = new DemoApi(() => start); const result = await demo.decide('INC-0042', 'approve', payload);
  let captured;
  const api = new LiveApi({ fetcher: async (url, init) => { captured = { url, init }; return Response.json(result); } });
  await api.decide('INC /42', 'approve', payload);
  assert.equal(captured.url, '/api/incidents/INC%20%2F42/approve');
  assert.equal(captured.init.method, 'POST'); assert.deepEqual(JSON.parse(captured.init.body), payload);
  assert.deepEqual(captured.init.headers, { 'Content-Type': 'application/json' });
});
test('malformed and contradictory responses are rejected before rendering', async () => {
  const api = new LiveApi({ fetcher: async () => Response.json([{ id: 'missing-fields' }]) });
  await assert.rejects(api.services(), /Invalid services/);
  const demo = new DemoApi(() => start); const incident = await demo.incident('INC-0042'); incident.state = 'resolved';
  assert.throws(() => validateIncident(incident), /verified resolution/);
  const services = await demo.services(); services[0].metrics.error_rate = 2.4;
  assert.throws(() => validateServices(services), /Invalid services/);
});
test('HTML from operational records is escaped, including attribute quotes', () => {
  assert.equal(escapeHTML('<script>"&\'</script>'), '&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;');
});

test('request keys work on HTTP origins without crypto.randomUUID', () => {
  const provider = { getRandomValues: bytes => { bytes.fill(171); return bytes; } };
  assert.match(decisionKey(provider), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
