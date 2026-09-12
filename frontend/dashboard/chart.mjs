export function drawChart(canvas, service, minutes) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const points = service.history.filter(p => Date.parse(p.timestamp) >= Date.now() - minutes * 60000);
  const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio; canvas.height = height * ratio; context.scale(ratio, ratio);
  const left = 43, right = width - 12, top = 12, bottom = height - 27;
  const max = Math.max(service.baseline_p95_ms * 1.5, ...points.map(p => p.p95_latency_ms), 1) * 1.15;
  const y = value => bottom - value / max * (bottom - top);
  const firstTime = points.length > 1 ? Date.parse(points[0].timestamp) : Date.now() - minutes * 60000;
  const lastTime = points.length ? Date.parse(points[points.length - 1].timestamp) : Date.now();
  const x = point => left + (Date.parse(point.timestamp) - firstTime) / Math.max(1, lastTime - firstTime) * (right - left);
  context.font = '10px ui-monospace, monospace'; context.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const value = max / 4 * i, pos = y(value);
    context.strokeStyle = '#2b2f35'; context.setLineDash([3, 5]); context.beginPath(); context.moveTo(left, pos); context.lineTo(right, pos); context.stroke();
    context.fillStyle = '#7d8591'; context.textAlign = 'right'; context.fillText(String(Math.round(value)), left - 10, pos + 3);
  }
  context.strokeStyle = '#6c927d'; context.setLineDash([5, 5]); context.beginPath(); context.moveTo(left, y(service.baseline_p95_ms)); context.lineTo(right, y(service.baseline_p95_ms)); context.stroke();
  context.setLineDash([]);
  if (points.length) {
    const gradient = context.createLinearGradient(0, top, 0, bottom); gradient.addColorStop(0, '#f58b5630'); gradient.addColorStop(1, '#f58b5600');
    context.beginPath(); context.moveTo(x(points[0]), bottom); points.forEach(point => context.lineTo(x(point), y(point.p95_latency_ms))); context.lineTo(x(points.at(-1)), bottom); context.closePath(); context.fillStyle = gradient; context.fill();
    context.beginPath(); points.forEach((point, i) => i ? context.lineTo(x(point), y(point.p95_latency_ms)) : context.moveTo(x(point), y(point.p95_latency_ms))); context.strokeStyle = '#f3915e'; context.lineWidth = 2; context.stroke();
    const end = points.at(-1); context.fillStyle = '#f3915e'; context.beginPath(); context.arc(x(end), y(end.p95_latency_ms), 3, 0, Math.PI * 2); context.fill();
    const stride = Math.max(1, Math.ceil(points.length / (width < 450 ? 4 : 7)));
    points.forEach((point, i) => { if (i % stride) return; context.fillStyle = '#7d8591'; context.textAlign = 'center'; context.fillText(new Date(point.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), x(point), height - 6); });
  }
}
