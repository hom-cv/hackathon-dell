# Blackbox demo runbook

Run everything from the repository root. Use a **new run ID for every rehearsal**.
This walkthrough uses the existing healthy and bad-join commits on `main`; it does
not use the agent-integration branch.

## Before the audience arrives

### Terminal 1 — prepare the healthy baseline

```sh
python3 scripts/configure.py
export DEMO_RUN_ID=join-demo-live-01

git switch main
DEMO_RUN_ID="$DEMO_RUN_ID" \
DEPLOYMENT_ID=dep-healthy \
GIT_SHA="$(git rev-parse HEAD)" \
docker compose up --build -d --wait

curl --fail http://localhost:8001/api/health
python3 scripts/generate-traffic.py --rate 5 --duration 90 --concurrency 10
```

Keep this terminal open so `DEMO_RUN_ID` remains set.

### Terminal 2 — connect NemoClaw

```sh
export BLACKBOX_API_URL=http://127.0.0.1:8001
export NEMOCLAW_SANDBOX_NAME=blackbox-agent
export NEMOCLAW_GATEWAY_PORT=8990

nemoclaw blackbox-agent status
bash scripts/install-nemoclaw-skill.sh
.venv/bin/python -m backend.incident_agent.worker --check
bash scripts/run-incident-worker.sh
```

Leave the worker running. It will poll, claim the first incident, ask NemoClaw to
investigate it, and submit the diagnosis automatically.

Open the operator dashboard and leave it ready to refresh:

```text
http://localhost:8001/admin
```

## Live demo

### 1. Deploy the known N+1 regression — Terminal 1

```sh
git switch --detach e3f687c
DEMO_RUN_ID="$DEMO_RUN_ID" \
DEPLOYMENT_ID=dep-bad-join \
GIT_SHA="$(git rev-parse HEAD)" \
docker compose up --build -d --wait
```

### 2. Generate degraded traffic

```sh
python3 scripts/generate-traffic.py --rate 5 --duration 40 --concurrency 10
```

### 3. Show detection and diagnosis

Refresh the dashboard to reveal the incident. Watch Terminal 2 for
`Investigation completed`, then display NemoClaw's report:

```sh
INCIDENT_ID="$(curl --fail --silent \
  'http://localhost:8001/api/incidents?state=diagnosed&limit=1' | \
  .venv/bin/python -c 'import json,sys; print(json.load(sys.stdin)["incidents"][0]["id"])')"

curl --fail --silent \
  "http://localhost:8001/api/incidents/$INCIDENT_ID/investigations" | \
  .venv/bin/python -m json.tool
```

Point out the N+1 diagnosis, confidence score, evidence, and rollback
recommendation in the report.

## After the demo — restore healthy code

Stop the worker with `Ctrl+C`, then run in Terminal 1:

```sh
git switch main
DEMO_RUN_ID="$DEMO_RUN_ID" \
DEPLOYMENT_ID=dep-recovered \
GIT_SHA="$(git rev-parse HEAD)" \
docker compose up --build -d --wait
```

Do not reuse `join-demo-live-01`; increment it before the next rehearsal.
