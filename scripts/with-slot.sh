#!/usr/bin/env bash
# Runs a command while holding one of a few machine-wide slots, so parallel agents don't start
# more headless browsers or full test suites than the machine can hold.
#
#   scripts/with-slot.sh browser npx playwright test
#   scripts/with-slot.sh browser node scripts/playtest.mjs --scenario tour --out /tmp/shots
#   scripts/with-slot.sh cpu npx vitest run
#
# GTA7_BROWSER_SLOTS (default 4) and GTA7_CPU_SLOTS (default 3) set the number of slots.
set -u
kind=${1:-}
shift || true
case "$kind" in
  browser) slots=${GTA7_BROWSER_SLOTS:-4} ;;
  cpu) slots=${GTA7_CPU_SLOTS:-3} ;;
  *) echo "usage: scripts/with-slot.sh browser|cpu <command...>" >&2; exit 2 ;;
esac
# Without flock (macOS) there is no slot to hold: run the command directly.
if ! command -v flock > /dev/null 2>&1; then
  exec "$@"
fi
dir=/tmp/gta7-slots/$kind
mkdir -p "$dir"
while true; do
  for i in $(seq 1 "$slots"); do
    exec {fd}>"$dir/slot-$i"
    if flock -n "$fd"; then
      "$@"
      status=$?
      flock -u "$fd"
      exit "$status"
    fi
    exec {fd}>&-
  done
  sleep 3
done
