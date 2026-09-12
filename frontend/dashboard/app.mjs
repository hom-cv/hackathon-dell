import { LiveApi } from './api.mjs';
import { DemoApi } from './fixtures.mjs';
import { ApiError, STATES, SCENARIOS, canDecide, decisionKey, isStale, escapeHTML as esc, statusTone } from './model.mjs';
import { drawChart } from './chart.mjs';
const $ = selector => document.querySelector(selector);
const icon = name => `<img class="icon" src="/static/assets/icons/${name}.svg" alt="">`;
const badge = (text, tone = 'neutral', dot = false) => `<span class="badge ${tone}">${dot ? '<span class="dot"></span>' : ''}${esc(text)}</span>`;
const time = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
const empty = (title, detail, symbol = 'activity') => `<div class="empty">${icon(symbol)}<h3>${esc(title)}</h3><p>${esc(detail)}</p></div>`;
const heading = (title, symbol, extra = '') => `<div class="panel-heading"><div>${icon(symbol)}<h2>${title}</h2></div>${extra}</div>`;
const params = new URLSearchParams(location.search);
const state = { mode: params.get('mode') === 'demo' ? 'demo' : 'live', scenario: 'awaiting_approval', view: 'overview', health: null, services: [], incidents: [], incident: null, selected: '', selectedService: '', errors: [], missing: [], loaded: false, updated: null, connected: false, query: '', filter: 'all', eventFilter: 'all', range: 30, chartTable: false, pending: false };
const live = new LiveApi(), demo = new DemoApi();
let api = state.mode === 'demo' ? demo : live;
let busy = false, generation = 0, requestAgain = false, review = null, chartObserver = null, toastTimer;
const keys = new Map();
const pages = { overview: ['Agent overview', 'Your systems. Your agent. Every action, in view.'], incidents: ['Incidents', 'Follow every incident from detection to verified recovery.'], activity: ['Agent activity', 'A visible record of tools, findings, and controlled actions.'], services: ['Services', 'Health and measurements across your local environment.'], settings: ['Settings', 'Data connections and local runtime status.'] };
function stale() { return Boolean(state.incident && isStale(state.incident.observed_at) || state.services.some(s => isStale(s.observed_at))); }
function decisionAllowed(incident = state.incident) {
  const current = state.incident;
  const matches = current && incident && current.id === incident.id && current.revision === incident.revision
    && current.recommendation?.id === incident.recommendation?.id && current.state === incident.state;
  return Boolean(matches && canDecide(incident, state.connected && !stale(), state.pending));
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6000); }
function setMobile(open) { $('#sidebar').classList.toggle('open', open); $('#scrim').hidden = !open; $('#menu').setAttribute('aria-expanded', String(open)); }
function navigate() {
  const route = location.hash.slice(1).split('/')[0];
  state.view = Object.hasOwn(pages, route) ? route : 'overview';
  state.query = ''; state.filter = 'all'; state.eventFilter = 'all'; setMobile(false); render();
}
async function refresh() {
  if (busy) { requestAgain = true; return; }
  busy = true; const version = generation, source = api;
  $('#refresh').disabled = true; $('#refresh').classList.add('refreshing');
  try {
    const results = await Promise.allSettled([source.health(), source.services(), source.incidents()]);
    if (version !== generation) return;
    const errors = [], missing = [];
    const names = ['Health check', 'Service telemetry', 'Incident controller'];
    results.forEach((result, n) => {
      if (result.status === 'rejected') {
        if (n > 0 && result.reason instanceof ApiError && result.reason.status === 404) missing.push(names[n]);
        else errors.push(`${names[n]}: ${result.reason?.message || 'Connection failed.'}`);
      }
    });
    if (results[0].status === 'fulfilled') state.health = results[0].value;
    else state.health = null;
    if (results[1].status === 'fulfilled') state.services = results[1].value;
    else if (missing.includes(names[1])) state.services = [];
    if (results[2].status === 'fulfilled') {
      state.incidents = results[2].value;
      const id = state.incidents.find(i => i.id === state.selected)?.id || state.incidents[0]?.id;
      if (id) {
        try { const detail = await source.incident(id); if (version !== generation) return; state.incident = detail; state.selected = id; }
        catch (error) { if (version !== generation) return; errors.push(`Incident detail: ${error.message}`); if (state.incident?.id !== id) state.incident = null; }
      } else { state.incident = null; state.selected = ''; }
    } else if (missing.includes(names[2])) { state.incidents = []; state.incident = null; }
    if (version !== generation) return;
    state.errors = errors; state.missing = missing; state.loaded = true;
    state.connected = errors.length === 0 && missing.length === 0 && ['ok', 'ready'].includes(state.health?.status);
    if (errors.length === 0) state.updated = new Date().toISOString();
    render();
  } finally {
    busy = false; $('#refresh').disabled = false; $('#refresh').classList.remove('refreshing');
    if (requestAgain || version !== generation) { requestAgain = false; void refresh(); }
  }
}
function switchSource() {
  if (state.pending) return;
  generation++; state.mode = $('#data-mode').value; state.scenario = $('#scenario').value || 'awaiting_approval';
  api = state.mode === 'demo' ? demo : live;
  if (state.mode === 'demo') demo.setScenario(state.scenario);
  Object.assign(state, { health: null, services: [], incidents: [], incident: null, selected: '', errors: [], missing: [], loaded: false, updated: null, connected: false });
  keys.clear(); closeDialog();
  const url = new URL(location.href); if (state.mode === 'demo') url.searchParams.set('mode', 'demo'); else url.searchParams.delete('mode'); history.replaceState(null, '', url);
  render(); void refresh();
}
function serviceTable() {
  if (!state.services.length) return empty('Service telemetry is not available yet', 'The inventory health check does not provide latency, error rates, or deployment measurements.', 'server');
  return `<div class="table-scroll"><table><thead><tr><th>Service</th><th>Status</th><th>p95 latency</th><th>Error rate</th><th>Deployment</th><th>Last signal</th></tr></thead><tbody>${state.services.map(s => `<tr><td><button class="service-name" data-service="${esc(s.id)}"><span class="service-icon">${icon('box')}</span>${esc(s.name)}${icon('external')}</button></td><td>${badge(isStale(s.observed_at) ? 'Stale' : s.status, isStale(s.observed_at) ? 'neutral' : statusTone(s.status), true)}</td><td class="mono ${s.metrics.p95_latency_ms > s.baseline_p95_ms * 2 ? 'amber-text' : ''}">${s.metrics.p95_latency_ms} <span class="muted">ms</span></td><td class="mono">${(s.metrics.error_rate * 100).toFixed(1)}%</td><td><span class="deployment">${icon('branch')}${esc(s.deployment_id)}</span></td><td class="mono muted">${time(s.observed_at)}</td></tr>`).join('')}</tbody></table></div>`;
}
function eventsMarkup(events) {
  const icons = { detection: 'incident', tool: 'terminal', finding: 'sparkles', approval: 'shield', action: 'play', verification: 'checks' };
  return `<div class="events">${events.map(e => `<article class="event"><span class="event-icon ${e.type}">${icon(icons[e.type])}</span><div class="event-body"><div class="event-title"><h4>${esc(e.title)}</h4><time>${time(e.timestamp)}</time></div><p>${esc(e.detail)}</p><div class="event-meta">${e.tool ? `<span class="tool-tag">${icon('terminal')}${esc(e.tool)}${Number.isFinite(e.duration_ms) ? `<span>${e.duration_ms} ms</span>` : ''}</span>` : ''}${(e.evidence_ids || []).map(id => `<button class="text-link" data-evidence="${esc(id)}">${icon('file')}${esc(id.replace('ev-', ''))}${icon('external')}</button>`).join('')}</div></div></article>`).join('')}</div>`;
}
function investigation() {
  const i = state.incident;
  if (!i) return `<section class="panel">${empty(state.missing.includes('Incident controller') ? 'Ready for the incident controller' : state.errors.length ? 'Incident data is unavailable' : 'All clear. No active investigation.', state.missing.includes('Incident controller') ? 'Agent actions and findings will appear here when the monitoring APIs are connected. Try demo scenarios to preview the complete workflow.' : state.errors.length ? 'Reconnect to the API to load incident records.' : 'New detections, agent findings, and recovery actions will appear here.', 'terminal')}</section>`;
  const path = ['detected', 'investigating', 'awaiting_approval', 'rolling_back', 'verifying', 'resolved'], position = path.indexOf(i.state);
  return `<section class="panel investigation">${heading('Current investigation <span class="mono muted incident-id">'+esc(i.id)+'</span>', 'incident', badge(STATES[i.state], statusTone(i.state), true))}<div class="incident-intro"><div><h3>${esc(i.title)}</h3>${badge(i.severity.toUpperCase(), statusTone(i.severity))}</div><p>${esc(i.summary)}</p><div class="incident-meta"><span>${icon('box')}${esc(i.service)}</span><span>${icon('clock')}Opened ${time(i.created_at)}</span><span>${icon('branch')}Revision ${i.revision}</span></div></div><div class="lifecycle">${path.map((step, n) => `<div class="${position > n ? 'done' : position === n ? 'current' : ''}"><span>${position > n ? icon('check') : n+1}</span><label>${['Detect', 'Investigate', 'Approve', 'Remediate', 'Verify', 'Resolve'][n]}</label></div>`).join('')}</div><div class="section-label"><span>AGENT ACTIVITY</span><span>${i.timeline.length} recorded events</span></div>${eventsMarkup(i.timeline)}</section>`;
}
function recommendation() {
  const i = state.incident, r = i?.recommendation;
  if (!r) return `<section class="panel">${heading('Recommended action', 'shield')}${empty(i?.state === 'investigation_failed' ? 'Investigation needs attention' : i ? 'Gathering evidence' : 'No recommendation available', i?.state === 'investigation_failed' ? 'The investigation failed. No rollback has been proposed.' : i ? 'A recommendation will appear when the agent has enough evidence.' : 'The controller will publish a scoped action for operator review.', 'shield')}</section>`;
  return `<section class="panel recommendation">${heading('Recommended action', 'shield', i.state === 'awaiting_approval' ? '<span class="orange-dot"></span>' : '')}<div class="recommendation-body">${badge(STATES[i.state], statusTone(i.state))}<h3>Roll back ${esc(r.service)}</h3><p>${esc(r.reason)}</p><div class="release-path"><div><span class="release-dot bad"></span><div><label>EXPECTED CURRENT DEPLOYMENT</label><code>${esc(r.expected_deployment_id)}</code></div></div><span class="release-arrow">↓</span><div><span class="release-dot good"></span><div><label>KNOWN-GOOD TARGET</label><code>${esc(r.target_deployment_id)}</code></div></div></div><div class="policy-note">${icon('shield')}<div><strong>Human approval required</strong><span>The controller validates policy and deployment identity before execution.</span></div></div>${i.state === 'awaiting_approval' ? `<button class="button primary full" data-decision="approve" ${decisionAllowed() ? '' : 'disabled'}>${icon('shield')}Review & approve rollback${icon('arrow')}</button><button class="button subtle full" data-decision="reject" ${decisionAllowed() ? '' : 'disabled'}>Reject recommendation</button>${!decisionAllowed() ? '<p class="small amber-text">A ready controller and fresh data are required to decide.</p>' : ''}` : `<div class="result-note ${statusTone(i.state)}">${icon(i.state === 'resolved' ? 'checks' : i.state.includes('failed') ? 'alert' : 'shield')}<span>${esc(i.state === 'resolved' ? 'Recovery verified by the controller' : i.state === 'rejected' ? 'Rejected. Manual follow-up required.' : i.action?.detail || STATES[i.state])}</span></div>`}</div></section>`;
}
function evidencePanel() {
  const i = state.incident; if (!i) return '';
  const icons = { metric: 'activity', trace: 'branch', log: 'file', diff: 'code' };
  return `<section class="panel">${heading('Investigation evidence', 'file', `<span class="count">${i.evidence.length}</span>`)}<div class="evidence-list">${i.evidence.map(e => `<button data-evidence="${esc(e.id)}"><span class="evidence-icon">${icon(icons[e.type])}</span><span><strong>${esc(e.title)}</strong><small>${e.type.toUpperCase()} · ${esc(e.id)}</small></span>${icon('external')}</button>`).join('')}</div></section>`;
}
function verificationPanel() {
  const v = state.incident?.verification; if (!v) return '';
  return `<section class="panel">${heading('Recovery verification', 'checks', badge(v.status, v.status === 'healthy' ? 'green' : 'amber'))}<div class="verification-body"><div class="before-after"><div><label>Before rollback</label><strong>${v.before_p95_ms} <small>ms</small></strong></div>${icon('arrow')}<div><label>After rollback</label><strong class="${v.status === 'healthy' ? 'green-text' : 'amber-text'}">${v.after_p95_ms ?? '—'} <small>ms</small></strong></div></div><p>${esc(v.detail)}</p><span class="muted small">${v.sample_count} fresh samples · ${v.windows} windows per service</span></div></section>`;
}
function stat(label, value, detail, symbol, tone = 'neutral') { return `<section class="stat"><div>${label}${icon(symbol)}</div><strong>${value}</strong><span class="stat-detail ${tone}"><i class="dot"></i>${detail}</span></section>`; }
function healthPanel() {
  return `<section class="panel health-panel">${heading('Local environment', 'server', badge(state.health ? 'API reachable' : 'Not connected', state.health ? 'green' : 'neutral'))}<div class="health-grid"><div>${icon('server')}<span><strong>Inventory API</strong><small>Authenticated health check</small></span>${badge(state.health?.status || 'unknown', statusTone(state.health?.status || 'unknown'), true)}</div><div>${icon('database')}<span><strong>MongoDB</strong><small>Reported by the API</small></span>${badge(state.health?.database || 'unknown', statusTone(state.health?.database || 'unknown'), true)}</div><div>${icon('terminal')}<span><strong>Incident controller</strong><small>${state.mode === 'demo' ? 'Simulated in this browser' : 'Agent investigation & recovery'}</small></span>${badge(state.mode === 'demo' ? 'simulated' : state.missing.includes('Incident controller') ? 'not connected' : state.connected ? 'available' : 'unknown', state.connected ? 'green' : 'neutral', true)}</div></div></section>`;
}
function chartPanel() {
  const s = state.services.find(s => s.id === state.selectedService) || state.services[0];
  const controls = s ? `<div class="chart-controls"><select id="chart-service" aria-label="Chart service">${state.services.map(item => `<option value="${esc(item.id)}" ${s.id === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select><select id="chart-range" aria-label="Chart time range"><option value="15" ${state.range === 15 ? 'selected' : ''}>Last 15 minutes</option><option value="30" ${state.range === 30 ? 'selected' : ''}>Last 30 minutes</option></select></div>` : badge('Awaiting telemetry');
  return `<section class="panel chart-panel">${heading('Service latency <span class="muted small">p95 response time</span>', 'activity', controls)}${s ? `<div class="chart-body"><div class="chart-summary"><strong>${s.metrics.p95_latency_ms}<small>ms</small></strong><span class="${s.metrics.p95_latency_ms > s.baseline_p95_ms * 2 ? 'amber-text' : 'green-text'}">${s.baseline_p95_ms ? (s.metrics.p95_latency_ms / s.baseline_p95_ms).toFixed(1) + '× baseline' : 'No baseline comparison'}</span><div class="chart-legend"><span><i></i>${esc(s.name)}</span><span><i class="dashed"></i>Baseline</span></div></div><canvas id="latency-chart" role="img" aria-label="${esc(s.name)} p95 ${s.metrics.p95_latency_ms} ms, baseline ${s.baseline_p95_ms} ms. Use View data to inspect measurement history."></canvas><button class="text-link chart-data-toggle" id="chart-data">${state.chartTable ? 'Hide' : 'View'} measurement data${icon('down')}</button>${state.chartTable ? `<div class="table-scroll"><table><thead><tr><th>Measurement time</th><th>p95 latency</th></tr></thead><tbody>${s.history.filter(p => Date.parse(p.timestamp) >= Date.now() - state.range*60000).map(p => `<tr><td>${time(p.timestamp)}</td><td>${p.p95_latency_ms} ms</td></tr>`).join('')}</tbody></table></div>` : ''}</div>` : `<div class="chart-placeholder"><div class="placeholder-grid"></div><div>${icon('activity')}<h3>Waiting for service measurements</h3><p>Latency history will appear when the telemetry API is connected.</p><button class="button" data-demo>Explore the demo${icon('arrow')}</button></div></div>`}</section>`;
}
function overview() {
  const active = state.incidents.filter(i => i.state !== 'resolved'), approvals = state.incidents.filter(i => i.state === 'awaiting_approval');
  const available = state.connected || state.incident;
  return `<div class="stats-grid">${stat('Monitored services', state.services.length ? `${state.services.filter(s => s.status === 'healthy' && !isStale(s.observed_at)).length}/${state.services.length}` : '—', state.services.length ? `${state.services.filter(s => s.status === 'degraded').length} services degraded` : 'Awaiting service telemetry', 'server', state.services.length ? active.length ? 'amber' : 'green' : 'neutral')}${stat('Active incidents', available ? active.length : '—', available ? active.length ? `${active.length} incident requires attention` : 'No active incidents' : 'Awaiting incident controller', 'incident', active.length ? 'red' : 'neutral')}${stat('Agent activity', available ? state.incident?.timeline.length || 0 : '—', 'Recorded events in selected incident', 'terminal')}${stat('Pending approvals', available ? approvals.length : '—', approvals.length ? 'Your review is needed' : available ? 'No decisions waiting' : 'Awaiting incident controller', 'shield', approvals.length ? 'amber' : 'neutral')}</div>${!state.services.length ? healthPanel() : ''}${chartPanel()}<div class="investigation-grid"><div>${investigation()}</div><div class="right-column">${recommendation()}${verificationPanel()}${evidencePanel()}</div></div>${state.services.length ? `<section class="panel services-panel">${heading('Monitored services', 'server', '<a class="text-link" href="#services">View services'+icon('arrow')+'</a>')}${serviceTable()}</section>` : ''}`;
}
function incidentsView() {
  const filtered = state.incidents.filter(i => `${i.id} ${i.title} ${i.service}`.toLowerCase().includes(state.query.toLowerCase()) && (state.filter === 'all' || (state.filter === 'active' ? i.state !== 'resolved' : i.state === state.filter)));
  return `<div class="filter-bar"><label class="search">${icon('search')}<input id="search-incidents" type="search" aria-label="Search incidents" placeholder="Search incidents…" value="${esc(state.query)}"></label><select id="incident-filter" aria-label="Incident status"><option value="all">All statuses</option><option value="active" ${state.filter === 'active' ? 'selected' : ''}>Active incidents</option>${Object.entries(STATES).map(([key, label]) => `<option value="${key}" ${state.filter === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><section class="panel incident-list">${filtered.length ? filtered.map(i => `<button class="incident-row ${state.incident?.id === i.id ? 'selected' : ''}" data-incident="${esc(i.id)}"><span class="severity-icon ${statusTone(i.state)}">${icon('incident')}</span><span><small>${esc(i.id)} · ${esc(i.service)}</small><strong>${esc(i.title)}</strong></span>${badge(STATES[i.state], statusTone(i.state))}${icon('arrow')}</button>`).join('') : empty(state.missing.includes('Incident controller') ? 'Incident controller is not connected' : 'No matching incidents', 'Incident records will appear here when available. Use the filters to find an investigation.', 'incident')}</section>${state.incident ? `<div class="detail-heading"><h2>Incident detail <span class="mono muted">${esc(state.incident.id)}</span></h2><button class="button" data-export>${icon('download')}Export record</button></div>` : '<div class="spacer"></div>'}<div class="investigation-grid"><div>${investigation()}</div><div class="right-column">${recommendation()}${verificationPanel()}${evidencePanel()}</div></div>`;
}
function activityView() {
  const events = (state.incident?.timeline || []).filter(e => (state.eventFilter === 'all' || state.eventFilter === e.type) && `${e.title} ${e.detail} ${e.tool || ''}`.toLowerCase().includes(state.query.toLowerCase()));
  return `<div class="filter-bar"><label class="search">${icon('search')}<input id="search-activity" type="search" aria-label="Search activity" placeholder="Search tools, actions, or findings…" value="${esc(state.query)}"></label><select id="activity-incident" aria-label="Activity incident">${state.incidents.length ? state.incidents.map(i => `<option value="${esc(i.id)}" ${state.incident?.id === i.id ? 'selected' : ''}>${esc(i.id)}</option>`).join('') : '<option>No incidents</option>'}</select><select id="event-filter" aria-label="Event type"><option value="all">All event types</option>${['detection', 'tool', 'finding', 'approval', 'action', 'verification'].map(type => `<option value="${type}" ${state.eventFilter === type ? 'selected' : ''}>${type}</option>`).join('')}</select><button class="button" data-export ${state.incident ? '' : 'disabled'}>${icon('download')}Export</button></div><section class="panel">${heading('Agent execution log', 'terminal', badge(state.incident?.id || 'No incident selected'))}${events.length ? eventsMarkup(events) : empty('No matching activity', 'Recorded tool calls, findings, and actions will appear here as the agent works.', 'terminal')}</section><p class="footnote">${icon('shield')}The log displays recorded activity. The backend controls investigation and execution.</p>`;
}
function servicesView() {
  const s = state.services.find(s => s.id === state.selectedService) || state.services[0];
  return `${healthPanel()}<section class="panel">${heading('Service health', 'server', badge(`${state.services.length} reporting services`))}${serviceTable()}</section>${s ? `<section class="panel service-detail">${heading(esc(s.name), 'box', badge(isStale(s.observed_at) ? 'Stale' : s.status, isStale(s.observed_at) ? 'neutral' : statusTone(s.status)))}<div class="service-detail-grid"><div><label>CURRENT DEPLOYMENT</label><code>${esc(s.deployment_id)}</code></div><div><label>P95 LATENCY / BASELINE</label><strong>${s.metrics.p95_latency_ms} ms <span class="muted">/ ${s.baseline_p95_ms} ms</span></strong></div><div><label>REQUESTS IN WINDOW</label><strong>${s.metrics.request_count}</strong></div><div><label>LAST MEASUREMENT</label><strong>${time(s.observed_at)}</strong></div></div><div class="service-detail-footer"><span>Deployment identity and measurements are reported by the telemetry API.</span><a class="text-link" href="#overview">View latency history${icon('arrow')}</a></div></section>` : ''}`;
}
function settingsView() {
  return `<div class="settings-grid"><section class="panel">${heading('Data connection', 'settings', badge(state.mode, state.mode === 'demo' ? 'amber' : 'green'))}<div class="settings-body"><h3>${state.mode === 'demo' ? 'You are viewing simulated data' : 'Using the local backend'}</h3><p>${state.mode === 'demo' ? 'Demo scenarios run in this browser. Decisions and recovery are simulated and reset when you reload.' : 'The dashboard reads the same-origin FastAPI API. Agent monitoring remains unavailable until the incident controller endpoints are implemented.'}</p><dl><div><dt>Transport</dt><dd>${state.mode === 'demo' ? 'In-memory fixtures' : 'Same-origin /api'}</dd></div><div><dt>Refresh interval</dt><dd>3 seconds</dd></div><div><dt>Stale threshold</dt><dd>30 seconds</dd></div><div><dt>Last successful refresh</dt><dd>${state.updated ? time(state.updated) : 'Never'}</dd></div></dl><div class="config-note">Live data never falls back to fixtures. The data source selector switches modes explicitly. <a href="/static/dashboard/API.md">View the integration contract</a>.</div></div></section><section class="panel">${heading('Runtime boundaries', 'shield')}<div class="settings-body"><div class="dependency"><span>Inventory API</span>${badge(state.health?.status || 'unknown', statusTone(state.health?.status || 'unknown'), true)}</div><div class="dependency"><span>MongoDB</span>${badge(state.health?.database || 'unknown', statusTone(state.health?.database || 'unknown'), true)}</div><div class="dependency"><span>Agent runtime</span>${badge(state.mode === 'demo' ? 'simulated' : 'not reported')}</div><div class="policy-note">${icon('shield')}<div><strong>Operator decisions are scoped</strong><span>Only an incident revision and recommendation can be approved or rejected. The browser never sends commands or database credentials.</span></div></div><a class="button full" href="/inventory">Open inventory demo${icon('external')}</a></div></section></div>`;
}
function render() {
  const activeElement = document.activeElement;
  const focus = activeElement?.id && $('#view').contains(activeElement) ? { id: activeElement.id, start: activeElement.selectionStart, end: activeElement.selectionEnd } : null;
  const [title, description] = pages[state.view];
  $('#page-title').textContent = title; $('#page-description').textContent = description;
  $('#breadcrumb').textContent = state.view === 'overview' ? 'Overview' : title; document.title = `${title} | Blackbox`;
  document.querySelectorAll('[data-view]').forEach(link => { const selected = link.dataset.view === state.view; link.classList.toggle('active', selected); if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  $('#data-mode').value = state.mode; $('#scenario-label').hidden = state.mode !== 'demo';
  $('#data-mode').disabled = state.pending; $('#scenario').disabled = state.pending;
  $('#mode-label').textContent = state.mode === 'demo' ? 'DEMO MODE' : 'LIVE CONNECTION';
  $('.mode-bar').classList.toggle('demo', state.mode === 'demo');
  $('#mode-description').textContent = state.mode === 'demo' ? 'Simulated telemetry & agent actions. No real changes are executed.' : 'Reading your local environment. Operational data stays local.';
  $('#environment-tag').textContent = state.mode === 'demo' ? 'DEMO' : 'LOCAL';
  $('#runtime-title').textContent = state.mode === 'demo' ? 'Demo environment' : state.health ? 'Inventory API connected' : state.loaded ? 'API not connected' : 'Connecting to environment';
  $('#runtime-description').textContent = state.mode === 'demo' ? 'Simulated agent & telemetry' : state.missing.length ? 'Agent monitoring not yet connected' : state.connected ? 'Monitoring endpoints available' : 'Waiting for the local backend';
  $('#runtime-dot').className = `dot ${state.health ? 'green' : 'amber'}`;
  $('#feed-label').textContent = state.errors.length ? 'Connection interrupted' : stale() ? 'Stale data' : !state.loaded ? 'Connecting' : state.mode === 'demo' ? 'Demo feed' : state.missing.length ? 'Partial connection' : 'Live feed';
  $('#feed-label').className = `feed-label ${state.errors.length ? 'red-text' : stale() || state.missing.length ? 'amber-text' : 'green-text'}`;
  const activeCount = state.incidents.filter(i => i.state !== 'resolved').length;
  $('#incident-count').textContent = activeCount; $('#incident-count').hidden = activeCount === 0;
  $('#notification-dot').hidden = !state.incidents.some(i => i.state === 'awaiting_approval');
  $('#last-updated').textContent = `${state.updated ? 'Updated '+time(state.updated) : 'Awaiting connection'} · ${state.mode === 'demo' ? 'SIMULATED DATA' : 'LOCAL API'}`;
  $('#alerts').innerHTML = `${state.errors.length ? `<div class="alert error">${icon('offline')}<div><strong>Connection interrupted</strong><p>${state.errors.map(esc).join(' ')} ${state.updated ? 'Showing last known data.' : ''} Approval is disabled.</p></div></div>` : ''}${state.missing.length ? `<div class="alert information">${icon('terminal')}<div><strong>${state.health ? 'Your inventory app is ready for the next step' : 'Monitoring APIs are not connected'}</strong><p>${state.missing.map(esc).join(' and ')} ${state.missing.length > 1 ? 'APIs are' : 'API is'} not implemented in this base. Explore demo scenarios to preview agent monitoring.</p></div><button class="text-link" data-demo>Explore demo${icon('arrow')}</button></div>` : ''}${stale() ? `<div class="alert warning">${icon('clock')}<div><strong>Telemetry is stale</strong><p>Some observations are over 30 seconds old. Decisions are paused until fresh data arrives.</p></div></div>` : ''}`;
  chartObserver?.disconnect();
  $('#view').innerHTML = !state.loaded ? '<div class="empty loading"><span class="spinner"></span><h3>Connecting to your operations feed…</h3></div>' : ({ overview, incidents: incidentsView, activity: activityView, services: servicesView, settings: settingsView })[state.view]();
  const canvas = $('#latency-chart');
  if (canvas) { const s = state.services.find(s => s.id === state.selectedService) || state.services[0]; chartObserver = new ResizeObserver(() => drawChart(canvas, s, state.range)); chartObserver.observe(canvas); }
  if (focus) { const element = document.getElementById(focus.id); element?.focus({ preventScroll: true }); if (typeof element?.setSelectionRange === 'function' && focus.start != null) element.setSelectionRange(focus.start, focus.end); }
  const confirm = $('#confirm-decision'); if (confirm && review) confirm.disabled = !decisionAllowed(review.incident);
}
function openDialog(title, content) {
  $('#dialog-title').textContent = title; $('#dialog-content').innerHTML = content;
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}
function closeDialog() { if (state.pending) return; $('#detail-dialog').close(); review = null; }
function showEvidence(id) {
  const item = state.incident?.evidence.find(e => e.id === id);
  if (!item) { toast('This evidence is not available in the current incident snapshot.'); return; }
  review = null;
  openDialog(item.title, `<div class="evidence-source">${badge(item.type)}<span>${esc(item.source)}</span></div><pre class="evidence-code">${item.content.split('\n').map(line => `<span class="${line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}">${esc(line)}\n</span>`).join('')}</pre><p class="muted small">Evidence reference: ${esc(item.id)}${state.mode === 'demo' ? ' · Illustrative demo fixture' : ''}</p>`);
}
function openReview(decision) {
  if (!decisionAllowed()) return;
  review = { decision, incident: structuredClone(state.incident) }; const i = review.incident, r = i.recommendation;
  openDialog(decision === 'approve' ? 'Review rollback approval' : 'Reject this recommendation?', `${badge(state.mode === 'demo' ? 'Simulated operator decision' : 'Operator decision', 'amber')}<h3>${esc(i.title)}</h3><p>${decision === 'approve' ? 'Approve this specific rollback. The controller will validate policy and deployment identity before restoring the known-good artifact, then verify recovery with fresh telemetry.' : 'Rejecting leaves the incident for manual follow-up. The proposed rollback will not be requested.'}</p><dl class="review-details"><div><dt>Incident / revision</dt><dd>${esc(i.id)} / ${i.revision}</dd></div><div><dt>Recommendation</dt><dd>${esc(r.id)}</dd></div><div><dt>Service</dt><dd>${esc(r.service)}</dd></div><div><dt>Expected current release</dt><dd>${esc(r.expected_deployment_id)}</dd></div><div><dt>Restore artifact from</dt><dd class="green-text">${esc(r.target_deployment_id)}</dd></div></dl><p id="decision-error" class="form-error" role="alert"></p><div class="dialog-actions"><button class="button" data-close>Cancel</button><button class="button ${decision === 'approve' ? 'primary' : 'danger'}" id="confirm-decision">${icon('shield')}${decision === 'approve' ? 'Approve rollback' : 'Reject recommendation'}</button></div>`);
}
async function submitDecision() {
  if (!review || !decisionAllowed(review.incident)) return;
  state.pending = true; render(); const snapshot = review, source = api;
  $('#confirm-decision').disabled = true; $('#confirm-decision').textContent = 'Recording decision…';
  $('#decision-error').textContent = ''; $('#close-dialog').disabled = true;
  const signature = `${snapshot.incident.id}:${snapshot.incident.revision}:${snapshot.incident.recommendation.id}:${snapshot.decision}`;
  if (!keys.has(signature)) keys.set(signature, decisionKey());
  try {
    const result = await source.decide(snapshot.incident.id, snapshot.decision, { recommendation_id: snapshot.incident.recommendation.id, incident_revision: snapshot.incident.revision, idempotency_key: keys.get(signature) });
    state.incident = result; state.pending = false; closeDialog();
    toast(snapshot.decision === 'approve' ? 'Approval recorded. Monitoring rollback and verification.' : 'Rejection recorded. No rollback was requested.');
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) { state.pending = false; closeDialog(); toast(error.message); }
    else { $('#decision-error').textContent = error.message || 'Unable to record decision. Retry with the same request key.'; $('#confirm-decision').textContent = 'Retry decision'; }
  } finally { state.pending = false; $('#close-dialog').disabled = false; render(); await refresh(); }
}
function exportRecord() {
  if (!state.incident) return;
  const blob = new Blob([JSON.stringify({ data_mode: state.mode, exported_at: new Date().toISOString(), incident: state.incident }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `blackbox-${state.incident.id.replace(/[^\w-]/g, '_')}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#scenario').innerHTML = Object.entries(SCENARIOS).map(([key, value]) => `<option value="${key}" ${key === state.scenario ? 'selected' : ''}>${value}</option>`).join('');
$('#data-mode').addEventListener('change', switchSource); $('#scenario').addEventListener('change', switchSource);
$('#refresh').addEventListener('click', () => void refresh());
$('#menu').addEventListener('click', () => setMobile(!$('#sidebar').classList.contains('open'))); $('#scrim').addEventListener('click', () => setMobile(false));
$('#close-dialog').addEventListener('click', closeDialog);
$('#detail-dialog').addEventListener('cancel', event => { if (state.pending) event.preventDefault(); else review = null; });
$('#notifications').addEventListener('click', () => { location.hash = 'incidents'; setTimeout(() => { state.filter = 'awaiting_approval'; render(); }, 0); });
$('#help').addEventListener('click', () => { review = null; openDialog('Your incident response, in view', `<p>Blackbox connects an inspectable investigation to an operator-controlled recovery workflow.</p><ol class="guide"><li><strong>Monitor</strong><p>Watch service health and latency. Live mode uses the local API; demo mode is explicitly simulated.</p></li><li><strong>Investigate</strong><p>Open metric, trace, log, and source-diff evidence behind the recommendation.</p></li><li><strong>Decide</strong><p>Review the incident revision and exact release target, then approve or reject.</p></li><li><strong>Verify</strong><p>Follow rollback and fresh telemetry. Only controller-verified recovery resolves the incident.</p></li></ol><div class="config-note">Demo timing is accelerated: about 4 seconds for rollback and 6 seconds for verification. Live recovery follows the runtime measurement windows.</div>`); });
document.addEventListener('click', event => {
  const target = event.target.closest('button'); if (!target || target.disabled) return;
  if (target.hasAttribute('data-demo')) { $('#data-mode').value = 'demo'; switchSource(); }
  if (target.dataset.evidence) showEvidence(target.dataset.evidence);
  if (target.dataset.decision) openReview(target.dataset.decision);
  if (target.dataset.incident) { state.selected = target.dataset.incident; state.incident = null; generation++; render(); void refresh(); }
  if (target.dataset.service) { state.selectedService = target.dataset.service; location.hash = 'services'; render(); }
  if (target.hasAttribute('data-export')) exportRecord();
  if (target.hasAttribute('data-close')) closeDialog();
  if (target.id === 'confirm-decision') void submitDecision();
  if (target.id === 'chart-data') { state.chartTable = !state.chartTable; render(); }
});
$('#view').addEventListener('input', event => { if (event.target.id.startsWith('search-')) { state.query = event.target.value; render(); } });
$('#view').addEventListener('change', event => {
  const { id, value } = event.target;
  if (id === 'incident-filter') state.filter = value;
  if (id === 'event-filter') state.eventFilter = value;
  if (id === 'chart-service') state.selectedService = value;
  if (id === 'chart-range') state.range = Number(value);
  if (id === 'activity-incident') { state.selected = value; state.incident = null; generation++; void refresh(); }
  render();
});
window.addEventListener('hashchange', navigate);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void refresh(); } });
window.addEventListener('online', () => void refresh());
window.addEventListener('offline', () => { if (state.mode === 'live') { state.connected = false; state.errors = ['Browser is offline.']; render(); } });
navigate(); void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
