import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { DemoApi } from '../dashboard/fixtures.mjs';
const root = new URL('../', import.meta.url);
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
async function mount({ mode = 'demo', fetcher } = {}) {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const dom = new JSDOM(html, { url: `http://localhost:8000/${mode === 'demo' ? '?mode=demo' : ''}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; let now = Date.parse('2026-09-12T14:00:00Z'); const intervals = [];
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  w.Date = ClockDate; w.structuredClone = structuredClone; w.AbortSignal = AbortSignal;
  w.fetch = fetcher || (() => { throw new Error('Demo must not fetch the live backend'); });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.setInterval = callback => { intervals.push(callback); return intervals.length; };
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const context = dom.getInternalVMContext(); const modules = new Map();
  async function load(url) {
    const key = String(url); if (modules.has(key)) return modules.get(key);
    const pending = readFile(url, 'utf8').then(source => new vm.SourceTextModule(source, { context, identifier: key }));
    modules.set(key, pending); return pending;
  }
  const app = await load(new URL('dashboard/app.mjs', root));
  await app.link((specifier, referencing) => load(new URL(specifier, referencing.identifier)));
  await app.evaluate(); await flush();
  const $ = selector => w.document.querySelector(selector);
  return { w, $, close: () => dom.window.close(), async advance(ms) { now += ms; intervals.forEach(callback => callback()); await flush(); },
    async change(selector, value) { $(selector).value = value; $(selector).dispatchEvent(new w.Event('change', { bubbles: true })); await flush(); },
    async click(selector) { assert.ok($(selector), `Control exists: ${selector}`); $(selector).click(); await flush(); } };
}
test('rendered review sends approval and follows rollback through verified recovery', async t => {
  const app = await mount(); t.after(app.close);
  assert.match(app.$('#view').textContent, /Inventory latency regression/);
  assert.equal(app.$('[data-decision="approve"]').disabled, false);
  await app.click('[data-decision="approve"]');
  assert.equal(app.$('#detail-dialog').open, true);
  assert.match(app.$('#dialog-content').textContent, /dep-bad/);
  assert.match(app.$('#dialog-content').textContent, /dep-healthy/);
  await app.click('#confirm-decision');
  assert.equal(app.$('#detail-dialog').open, false);
  assert.match(app.$('#view').textContent, /Rolling back/);
  await app.advance(4000); assert.match(app.$('#view').textContent, /Verifying recovery/);
  await app.advance(6000); assert.match(app.$('#view').textContent, /Recovery verified by the controller/);
  assert.equal(app.$('[data-decision="approve"]'), null);
});
test('rejection is visible and never produces a rollback action', async t => {
  const app = await mount(); t.after(app.close);
  await app.click('[data-decision="reject"]'); await app.click('#confirm-decision');
  assert.match(app.$('#view').textContent, /Rejected. Manual follow-up required/);
  assert.doesNotMatch(app.$('#view').textContent, /Executing approved rollback/);
});
test('stale, unavailable and inconclusive scenarios remain honest in rendered UI', async t => {
  const app = await mount(); t.after(app.close);
  await app.change('#scenario', 'stale');
  assert.match(app.$('#alerts').textContent, /Telemetry is stale/);
  assert.equal(app.$('[data-decision="approve"]').disabled, true);
  await app.change('#scenario', 'inconclusive'); await app.advance(120000);
  assert.match(app.$('#view').textContent, /Insufficient fresh samples/);
  assert.doesNotMatch(app.$('#view').textContent, /Recovery verified by the controller/);
  await app.change('#scenario', 'unavailable');
  assert.match(app.$('#alerts').textContent, /Connection interrupted/);
  assert.equal(app.$('[data-decision="approve"]'), null);
});
test('existing health endpoint is useful while unavailable agent APIs stay explicit', async t => {
  const app = await mount({ mode: 'live', fetcher: async url => url.endsWith('/health') ? Response.json({ status: 'ok', database: 'connected' }) : Response.json({ detail: 'Not Found' }, { status: 404 }) }); t.after(app.close);
  assert.match(app.$('#view').textContent, /Inventory API/);
  assert.match(app.$('#alerts').textContent, /not implemented in this base/);
  assert.doesNotMatch(app.$('#view').textContent, /Inventory latency regression/);
  assert.equal(app.$('[data-decision="approve"]'), null);
  await app.click('[data-demo]'); assert.match(app.$('#view').textContent, /Inventory latency regression/);
});
test('evidence viewer escapes content and source diff is inspectable', async t => {
  const app = await mount(); t.after(app.close);
  await app.click('[data-evidence="ev-diff"]');
  assert.match(app.$('#detail-dialog').textContent, /inventory.find_one/);
  assert.ok(app.$('.evidence-code .added'));
  assert.ok(app.$('.evidence-code .removed'));
  assert.match(app.$('#detail-dialog').textContent, /Illustrative demo fixture/);
});
test('activity filters and navigation update visible records', async t => {
  const app = await mount(); t.after(app.close);
  app.w.location.hash = 'activity'; app.w.dispatchEvent(new app.w.HashChangeEvent('hashchange')); await flush();
  await app.change('#event-filter', 'tool');
  assert.equal(app.w.document.querySelectorAll('.event').length, 2);
  const search = app.$('#search-activity'); search.focus(); search.value = 'git.diff'; search.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  assert.equal(app.w.document.querySelectorAll('.event').length, 1);
  assert.equal(app.w.document.activeElement.id, 'search-activity');
  assert.match(app.$('#view').textContent, /Inspected local source changes/);
});
test('live retry reuses its idempotency key and stale conflict requires another review', async t => {
  const backend = new DemoApi(() => Date.parse('2026-09-12T14:00:00Z')); const submitted = [];
  const app = await mount({ mode: 'live', fetcher: async (url, options) => {
    if (options.method === 'POST') { submitted.push(JSON.parse(options.body)); return Response.json({ detail: submitted.length === 1 ? 'Temporary failure' : 'Recommendation changed. Review again.' }, { status: submitted.length === 1 ? 503 : 409 }); }
    if (url.endsWith('/health')) return Response.json(await backend.health());
    if (url.endsWith('/services')) return Response.json(await backend.services());
    if (url.endsWith('/incidents')) return Response.json(await backend.incidents());
    return Response.json(await backend.incident('INC-0042'));
  } }); t.after(app.close);
  await app.click('[data-decision="approve"]'); await app.click('#confirm-decision');
  assert.match(app.$('#decision-error').textContent, /Temporary failure/);
  await app.click('#confirm-decision');
  assert.equal(submitted.length, 2); assert.equal(submitted[0].idempotency_key, submitted[1].idempotency_key);
  assert.equal(app.$('#detail-dialog').open, false); assert.match(app.$('#toast').textContent, /Review again/);
});
test('static asset paths exist and inventory behavior is preserved', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="(\/static\/[^"?#]+)"/g)) {
    await readFile(new URL(match[1].replace('/static/', ''), root));
  }
  const inventory = await readFile(new URL('inventory.html', root), 'utf8');
  assert.match(inventory, /id="item-form"/); assert.match(inventory, /src="\/static\/app.js"/);
  const app = await readFile(new URL('app.js', root), 'utf8'); assert.match(app, /api\("\/items"\)/);
});

test('a refreshed incident revision disables an already-open approval review', async t => {
  let revision = 5;
  const backend = new DemoApi(() => Date.parse('2026-09-12T14:00:00Z'));
  const app = await mount({ mode: 'live', fetcher: async url => {
    if (url.endsWith('/health')) return Response.json(await backend.health());
    if (url.endsWith('/services')) return Response.json(await backend.services());
    if (url.endsWith('/incidents')) return Response.json(await backend.incidents());
    const incident = await backend.incident('INC-0042'); incident.revision = revision; return Response.json(incident);
  } }); t.after(app.close);
  await app.click('[data-decision="approve"]');
  assert.equal(app.$('#confirm-decision').disabled, false);
  revision = 6; await app.advance(3000);
  assert.equal(app.$('#confirm-decision').disabled, true);
  await app.click('#close-dialog'); await app.click('[data-decision="approve"]');
  assert.equal(app.$('#confirm-decision').disabled, false);
  assert.match(app.$('#dialog-content').textContent, /INC-0042 \/ 6/);
});
