#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export NEMOCLAW_GATEWAY_PORT="${NEMOCLAW_GATEWAY_PORT:-8990}"
export NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-blackbox-agent}"

exec .venv/bin/python -m backend.incident_agent.worker \
  --poll-interval "${BLACKBOX_AGENT_POLL_INTERVAL:-2}"
