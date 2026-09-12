# Frontend

A basic inventory UI with search, stock filters, item creation, and stock editing. The FastAPI server serves it at `/`, with assets under `/static`. There is no frontend build step or runtime CDN dependency. Icons are vendored from Lucide; the license is in `assets/icons/LICENSE`.

The UI reads and writes through `/api/items`. It never connects directly to MongoDB or receives database credentials.

To connect another frontend, use this request against the backend origin:

```js
const response = await fetch("http://localhost:8000/api/items", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sku: "PART-006", name: "USB adapter", stock: 12 }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.detail);
```

Configure the backend's `CORS_ORIGINS` with the exact frontend origin, such as `http://localhost:5173`, and restart it. When testing remotely, `localhost` means the browser's machine: use the backend's SSH-forwarded local port or its GB10 address. See [MongoDB setup](../docs/mongodb-setup.md).
