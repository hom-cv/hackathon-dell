# MongoDB and Frontend Setup

This implements the first Person 1 milestone: browser -> inventory API -> local MongoDB. Checkout, anomaly detection, the AI agent, and rollback are separate follow-on work.

## Start With Docker

Prerequisites: Docker Engine with Compose V2 and Python 3. Run from the repository root:

```sh
python3 scripts/configure.py
docker compose up --build -d --wait
docker compose ps
curl -fsS http://localhost:8000/api/health
```

Open `http://localhost:8000`. Add an item or edit its stock, reload the page, and confirm the value persists. API documentation is at `/docs`.

`configure.py` generates distinct administrator/application passwords in a gitignored, owner-readable `.env`. It preserves an existing file. MongoDB requires authentication, has no published host port in Compose, and stores data in `blackbox-demo_mongo_data`. The web server defaults to host loopback. Choose a free `HTTP_PORT` in `.env` if 8000 is occupied.

The application user can read/write `shop` and `blackbox`. The inventory API uses `shop.inventory`. MongoDB creates the `blackbox` database when the first evidence document is inserted. The database user is initialized only on a fresh volume: editing passwords in `.env` does not change credentials in an existing database.

Useful operations:

```sh
docker compose logs --tail 100 web mongodb
docker compose restart web
docker compose down
```

The last command keeps the database volume. Repeating startup preserves created items and stock edits.

## Native Mac Setup in This Workspace

Docker was unavailable on this Mac, so native MongoDB 8.0.32 was installed under `.context/mongodb/`. The downloaded Apple Silicon archive was checked against MongoDB's published SHA-256. A Python environment is installed under `.venv`. Credentials are in `.env`, and database files are in `.context/mongodb/data`.

To restart MongoDB when it is stopped, from this workspace:

```sh
.context/mongodb/bin/mongod --auth --bind_ip 127.0.0.1 --port 27017 \
  --dbpath .context/mongodb/data --logpath .context/mongodb/mongod.log --fork
.venv/bin/python scripts/init-local-mongo.py
.venv/bin/uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Do not start a second server on an occupied port. The initializer creates users on a fresh authenticated local MongoDB and preserves existing accounts on subsequent runs. MongoDB listens at `127.0.0.1:27017`; it requires the credentials from `.env`. MongoDB logs are in `.context/mongodb/mongod.log`; the agent-started web server logs are in `.context/web.log`.

This native installation is workspace-local, not a login service. It is not included in Git or copied to the GB10. Use Compose for a fresh machine.

## Deploy to the GB10

The GB10 needs SSH access, Python 3, Docker Engine, and Compose V2. The SSH user must already be able to run Docker. The pinned MongoDB image includes Linux ARM64; the API image is built on the destination. MongoDB and this frontend/API do not require GPU access.

From this Mac:

```sh
bash scripts/deploy-gb10.sh user@gb10-host
```

The script checks Docker access, copies the app to `~/blackbox-mongo-demo`, generates credentials on that host, and starts the services with health checks. It does not copy this Mac's `.env`, native MongoDB files, Git history, or database data. Each host has its own database; the five starter items are seeded on startup. The remote `.env` and database volume persist across repeat deployments.

For the default remote port, open a separate SSH tunnel:

```sh
ssh -N -L 8001:127.0.0.1:8000 user@gb10-host
```

Visit `http://localhost:8001`. Choose another local port if 8001 is occupied. If you changed the GB10's `HTTP_PORT`, adjust the tunnel's destination port too. For direct access on a trusted demo LAN, set remote `HTTP_HOST=0.0.0.0` and restart Compose; the demo inventory API has no user login and permits writes from anyone who can reach it.

## Frontend Handoff

Give your frontend teammate the API base URL and [endpoint contract](../backend/README.md), not the MongoDB password. The included UI uses relative `/api` URLs. A separate frontend needs an exact origin in `CORS_ORIGINS` and the correct backend address or development proxy.

Verify on the GB10:

1. `/api/health` reports `{"status":"ok","database":"connected"}`.
2. Create an item from the browser and confirm it appears after reload.
3. Update stock, restart the web container, and confirm the value is unchanged.
4. Check `docker compose ps` for healthy MongoDB and web services.

These steps test the actual deployed database, not a mock or browser-local store. GB10 deployment remains unverified until an SSH target is supplied and the remote checks run.

## References

Database installation follows [MongoDB Community installation](https://www.mongodb.com/docs/manual/administration/install-community/). The container architecture is listed in the [official MongoDB image manifest](https://github.com/docker-library/official-images/blob/master/library/mongo). Static asset serving uses [FastAPI StaticFiles](https://fastapi.tiangolo.com/tutorial/static-files/).
