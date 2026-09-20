#!/bin/zsh
# Auriga router supervisor: keeps exactly ONE detached router alive, restarts
# it if it dies. Uses the router's own pidfile for single-instance safety; the
# supervisor itself is single-instance via an flock lock (see below).
#
# Usage: ./supervisor.sh   (run detached with nohup; loops forever)
set -u

NODE="${NODE:-$HOME/.local/share/mise/installs/node/24.18.0/bin/node}"
DIR="${DIR:-$HOME/Documents/work/dostal/code/auriga/src/router}"
ROUTER="$DIR/auriga-router.mjs"
SUP_LOCK="/tmp/auriga-supervisor.lock"
ROUTER_LOG="/tmp/auriga-router.log"
SUP_LOG="/tmp/auriga-supervisor.log"

# supervisor single-instance, via flock rather than a PID file. A PID file
# survives a container restart (the writable layer persists across `docker
# restart`, only PIDs reset), so a stale PID can collide with the new boot's
# own PID 1 and make the guard believe a dead supervisor is still running,
# permanently wedging the container in a restart loop. flock's lock is held
# by an open file descriptor, which the kernel releases the instant the old
# process (and its whole PID namespace) is gone -- immune to PID reuse.
exec 9>"$SUP_LOCK"
if ! flock -n 9; then
  echo "supervisor already running; exiting" >&2
  exit 3
fi

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
