#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || "$1" == -* ]]; then
  printf 'Usage: bash scripts/deploy-gb10.sh user@gb10-host\n' >&2
  exit 2
fi
target="$1"
cd "$(dirname "$0")/.."

ssh "$target" 'set -eu
command -v python3 >/dev/null
docker compose version
docker info --format "{{.Architecture}}"
mkdir -p "$HOME/blackbox-mongo-demo"
'

COPYFILE_DISABLE=1 tar --exclude=__pycache__ --exclude=.pytest_cache \
  --exclude=node_modules --exclude=dist -czf - \
  compose.yaml .dockerignore backend frontend scripts |
  ssh "$target" 'tar -xzf - -C "$HOME/blackbox-mongo-demo"'

ssh "$target" 'set -eu
cd "$HOME/blackbox-mongo-demo"
python3 scripts/configure.py
docker compose up --build -d --wait --wait-timeout 180
docker compose ps
docker compose exec -T web python -c '\''import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=5).read().decode())'\''
docker compose exec -T web python -c '\''import urllib.request
for path in ("/", "/inventory", "/static/dashboard/app.mjs", "/static/dashboard/dashboard.css"):
    response = urllib.request.urlopen("http://127.0.0.1:8000" + path, timeout=5)
    print(path, response.status, response.headers.get("Content-Type"))'\''
'

printf '\nFor the default port, open a tunnel with:\n  ssh -N -L 8001:127.0.0.1:8000 %s\nThen visit http://localhost:8001\n' "$target"
