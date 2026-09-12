const $ = (selector) => document.querySelector(selector);

function emptyState(title, message) {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state compact";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const detail = document.createElement("p");
  detail.textContent = message;
  wrapper.append(heading, detail);
  return wrapper;
}

function renderServices(services) {
  const list = $("#service-list");
  if (!services.length) {
    list.replaceChildren(emptyState("No workload telemetry yet", "Use the inventory API, then refresh."));
    $("#service-list-caption").textContent = "Waiting for workload requests.";
    return;
  }
  const rows = services.map((service) => {
    const row = document.createElement("div");
    row.className = "service-row";
    const dot = document.createElement("span");
    dot.className = `status-dot ${service.status}`;
    const name = document.createElement("span");
    name.className = "service-name";
    name.textContent = service.name;
    const detail = document.createElement("span");
    detail.className = "service-detail";
    detail.textContent = `${service.status} · ${service.average_latency_ms.toFixed(1)} ms · ${service.request_count} requests`;
    row.append(dot, name, detail);
    return row;
  });
  list.replaceChildren(...rows);
  $("#service-list-caption").textContent = "Five-minute service window from blackbox.logs.";
}

function renderActivity(activity) {
  const list = $("#activity-list");
  if (!activity.length) {
    list.className = "empty-state compact";
    list.replaceChildren(emptyState("No activity recorded", "Inventory API requests will appear here."));
    return;
  }
  list.className = "activity-feed";
  const rows = activity.map((event) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    for (const [className, value] of [
      ["activity-method", event.http_method],
      ["activity-route", event.http_route],
      ["activity-status", String(event.status_code)],
      ["activity-duration", `${event.duration_ms.toFixed(1)} ms`],
      ["activity-time", new Date(event.timestamp).toLocaleTimeString()],
    ]) {
      const cell = document.createElement("span");
      cell.className = className;
      if (className === "activity-status" && event.status_code >= 400) cell.classList.add("error");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  });
  list.replaceChildren(...rows);
}

async function refreshDashboard() {
  const button = $("#refresh-dashboard");
  button.disabled = true;
  try {
    const response = await fetch("/api/admin/overview", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
    const data = await response.json();
    $("#active-incidents").textContent = data.summary.active_incidents.toLocaleString();
    $("#healthy-services").textContent = data.summary.healthy_services.toLocaleString();
    $("#average-latency").textContent = data.summary.average_latency_ms == null
      ? "—" : `${data.summary.average_latency_ms.toFixed(1)} ms`;
    $("#requests-per-minute").textContent = data.summary.requests_per_minute.toLocaleString();
    $("#incident-caption").textContent = data.summary.active_incidents ? "Requires operator attention" : "No active incidents";
    $("#service-caption").textContent = data.services.length ? `${data.services.length} reporting` : "No recent workload traffic";
    const telemetryHealthy = data.telemetry.dropped_record_count === 0 && data.telemetry.write_failure_count === 0;
    $("#system-status").textContent = telemetryHealthy ? "Telemetry connected" : "Telemetry data incomplete";
    $(".system-dot").style.background = telemetryHealthy ? "#34785f" : "#b35f52";
    renderServices(data.services);
    renderActivity(data.activity);
  } catch (error) {
    $("#system-status").textContent = "Telemetry unavailable";
    $("#system-status").classList.add("load-error");
    $("#service-list-caption").textContent = error.message || "Dashboard could not be loaded.";
  } finally {
    button.disabled = false;
  }
}

$("#refresh-dashboard").addEventListener("click", refreshDashboard);
refreshDashboard();
