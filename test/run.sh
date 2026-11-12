#!/usr/bin/env bash
# Runs the collector against the mock API for N simulated hours.
set -euo pipefail
cd "$(dirname "$0")/.."
HOURS=${1:-6}
rm -rf test/state test/public
node test/mock-server.mjs >/tmp/mock.log 2>&1 &
MOCK=$!
trap "kill $MOCK" EXIT
sleep 0.5
for t in $(seq 0 $((HOURS-1))); do
  echo $t > test/.tick
  BLIZZARD_CLIENT_ID=x BLIZZARD_CLIENT_SECRET=y \
  BLIZZARD_API_BASE=http://localhost:8787 BLIZZARD_OAUTH_URL=http://localhost:8787/token \
  REGIONS=us STATE_DIR=test/state OUT_DIR=test/public \
  node collector/collect.mjs | tail -n ${VERBOSE:-3}
done
