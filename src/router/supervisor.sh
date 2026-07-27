#!/bin/zsh
# Auriga router supervisor: keeps exactly ONE detached router alive, restarts
# it if it dies. Uses the router's own pidfile for single-instance safety; the
# supervisor itself is single-instance via its own pidfile.
#
# Usage: ./supervisor.sh   (run detached with nohup; loops forever)
set -u

NODE="${NODE:-$HOME/.local/share/mise/installs/node/24.18.0/bin/node}"
DIR="${DIR:-$HOME/Documents/work/dostal/code/auriga/src/router}"
ROUTER="$DIR/auriga-router.mjs"
SUP_PID="/tmp/auriga-supervisor.pid"
ROUTER_LOG="/tmp/auriga-router.log"
SUP_LOG="/tmp/auriga-supervisor.log"

# supervisor single-instance
if [[ -f "$SUP_PID" ]]; then
  old=$(cat "$SUP_PID" 2>/dev/null)
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    echo "supervisor already running (pid $old); exiting" >&2
    exit 3
  fi
fi
echo $$ > "$SUP_PID"
trap 'rm -f "$SUP_PID"' EXIT INT TERM

echo "$(date -u +%FT%TZ) supervisor start pid=$$" >> "$SUP_LOG"
while true; do
  # is the router alive (per its pidfile)?
  alive=0
  if [[ -f /tmp/auriga-router.pid ]]; then
    rp=$(cat /tmp/auriga-router.pid 2>/dev/null)
    if [[ -n "$rp" ]] && kill -0 "$rp" 2>/dev/null; then alive=1; fi
  fi
  if [[ "$alive" -eq 0 ]]; then
    echo "$(date -u +%FT%TZ) router not alive; starting" >> "$SUP_LOG"
    nohup "$NODE" "$ROUTER" "$@" >> "$ROUTER_LOG" 2>&1 &
    echo "$(date -u +%FT%TZ) started router pid=$!" >> "$SUP_LOG"
  fi
  sleep 30
done
