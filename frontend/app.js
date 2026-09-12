const $ = (selector) => document.querySelector(selector);
let items = [];
let editingSku = null;
let saving = false;
const dialog = $("#item-dialog");
const iconNames = { KEY: "keyboard", MOU: "mouse", HUB: "usb", CAB: "cable", AUD: "headphones" };

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map((error) => error.msg).join(" ") : body.detail;
    throw new Error(detail || "The request failed.");
  }
  return body;
}

function notice(message = "", isError = false) {
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", isError);
}

function render() {
  const query = $("#search").value.trim().toLowerCase();
  const filter = $("#stock-filter").value;
  const visible = items.filter((item) => {
    const matches = `${item.name} ${item.sku}`.toLowerCase().includes(query);
    return matches && (filter === "all" || (filter === "out" && item.stock === 0)
      || (filter === "low" && item.stock > 0 && item.stock < 10)
      || (filter === "available" && item.stock > 0));
  });
  $("#total-items").textContent = items.length.toLocaleString();
  $("#total-stock").textContent = items.reduce((sum, item) => sum + item.stock, 0).toLocaleString();
  $("#out-of-stock").textContent = items.filter((item) => item.stock === 0).length;
  $("#result-count").textContent = `${visible.length} of ${items.length} items`;
  const rows = visible.map((item) => {
    const row = $("#item-row").content.cloneNode(true);
    row.querySelector(".name").textContent = item.name;
    row.querySelector(".sku").textContent = item.sku;
    row.querySelector(".stock").textContent = item.stock.toLocaleString();
    const status = row.querySelector(".stock-status");
    status.textContent = item.stock === 0 ? "Out of stock" : item.stock < 10 ? "Low stock" : "In stock";
    status.classList.add(item.stock === 0 ? "out" : item.stock < 10 ? "low" : "available");
    row.querySelector(".item-icon img").src = `/static/assets/icons/${iconNames[item.sku.split("-")[0]] || "package"}.svg`;
    const button = row.querySelector(".edit-item");
    button.title = `Edit stock for ${item.name}`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => openDialog(item));
    return row;
  });
  $("#inventory").replaceChildren(...rows);
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty";
    cell.textContent = items.length ? "No matching items." : "No inventory items.";
    row.append(cell);
    $("#inventory").append(row);
  }
}

async function refresh() {
  $("#refresh").disabled = true;
  try {
    const [nextItems] = await Promise.all([api("/items"), api("/health")]);
    items = nextItems;
    render();
    $("#connection").className = "connection online";
    $("#connection-label").textContent = "Connected";
    $("#last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    notice();
    return true;
  } catch (error) {
    $("#connection").className = "connection offline";
    $("#connection-label").textContent = "Disconnected";
    notice(error.message || "Unable to connect.", true);
    if (!items.length) {
      render();
      $("#inventory .empty").textContent = "Inventory unavailable. Retry with refresh.";
    }
    return false;
  } finally {
    $("#refresh").disabled = false;
  }
}

function openDialog(item = null) {
  editingSku = item?.sku || null;
  $("#item-form").reset();
  $("#dialog-title").textContent = item ? "Edit stock" : "Add item";
  $("#save-item").textContent = item ? "Save changes" : "Add item";
  $("#item-name").value = item?.name || "";
  $("#item-sku").value = item?.sku || "";
  $("#item-stock").value = item?.stock ?? 0;
  $("#item-name").disabled = Boolean(item);
  $("#item-sku").disabled = Boolean(item);
  $("#form-error").textContent = "";
  dialog.showModal();
  $(item ? "#item-stock" : "#item-name").focus();
}

$("#item-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  $("#save-item").disabled = true;
  $("#form-error").textContent = "";
  try {
    const body = { stock: Number($("#item-stock").value) };
    if (!editingSku) Object.assign(body, { name: $("#item-name").value, sku: $("#item-sku").value });
    await api(editingSku ? `/items/${encodeURIComponent(editingSku)}` : "/items", {
      method: editingSku ? "PATCH" : "POST", body: JSON.stringify(body),
    });
    dialog.close();
    const loaded = await refresh();
    if (loaded) notice("Inventory saved.");
    else notice("Saved, but inventory could not be refreshed. Retry with refresh.", true);
  } catch (error) {
    $("#form-error").textContent = error.message || "Unable to save item.";
  } finally {
    saving = false;
    $("#save-item").disabled = false;
  }
});

for (const selector of ["#close-dialog", "#cancel-dialog"]) {
  $(selector).addEventListener("click", () => { if (!saving) dialog.close(); });
}
dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
$("#add-item").addEventListener("click", () => openDialog());
$("#refresh").addEventListener("click", refresh);
$("#search").addEventListener("input", render);
$("#stock-filter").addEventListener("change", render);
refresh();
