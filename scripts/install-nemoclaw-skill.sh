#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
sandbox="${NEMOCLAW_SANDBOX_NAME:-blackbox-agent}"

command -v nemoclaw >/dev/null || {
  printf 'nemoclaw is not installed.\n' >&2
  exit 1
}

nemoclaw "$sandbox" status
for skill in blackbox-health blackbox-incidents blackbox-sre; do
  nemoclaw "$sandbox" skill install "./agent/skills/$skill"
done
nemoclaw "$sandbox" skill list
