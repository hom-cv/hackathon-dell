// Optional static preview. Production uses the existing FastAPI static mount.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/plain' };
const port = Number(process.env.DASHBOARD_PORT || 5173);
const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: 'Static preview has no backend API. Use demo mode or launch the FastAPI application.' })); return;
  }
  try {
    const relative = ['/', '/dashboard'].includes(pathname) ? 'index.html' : pathname === '/inventory' ? 'inventory.html' : decodeURIComponent(pathname.replace(/^\/static\//, ''));
    const target = resolve(root, relative);
    if (!target.startsWith(root.endsWith(sep) ? root : root + sep) || !types[extname(target)]) { response.writeHead(404); response.end(); return; }
    const data = await readFile(target);
    response.writeHead(200, { 'Content-Type': `${types[extname(target)]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Dashboard preview: http://127.0.0.1:${port}/?mode=demo`));
