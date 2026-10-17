#!/bin/sh
# Auriga router supervisor: keeps exactly ONE detached router alive, restarts
# it if it dies. Uses the router's own pidfile for single-instance safety; the
# supervisor itself is single-instance via an flock lock (see below).
#
# POSIX sh with no host-specific defaults, so it runs unchanged in the alpine
# image and on a bare host (PANT-817).
#
# Usage: ./supervisor.sh [router flags...]   (loops forever)
#
# Env:
#   NODE                  node binary (default: `node` on PATH; fails loudly if absent)
#   DIR                   router directory (default: this script's directory)
#   AURIGA_PIDFILE        router pidfile (default: /tmp/auriga-router.pid, same as the router)
#   AURIGA_SUPERVISOR_LOCK  supervisor flock file (default: next to the pidfile)
#   ROUTER_LOG            append router stdout/stderr here (default: inherit this
#                         script's stdout/stderr, i.e. container logs)
#   SUP_LOG               append supervisor messages here (default: stderr)
#   AURIGA_SUPERVISOR_INTERVAL  seconds between liveness checks (default: 30)
set -u

NODE="${NODE:-$(command -v node || true)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "supervisor: node not found (set NODE or put node on PATH)" >&2
  exit 1
fi

DIR="${DIR:-$(cd "$(dirname "$0")" && pwd)}"
ROUTER="$DIR/auriga-router.mjs"
if [ ! -f "$ROUTER" ]; then
  echo "supervisor: router not found at $ROUTER (set DIR)" >&2
  exit 1
fi

PIDFILE="${AURIGA_PIDFILE:-/tmp/auriga-router.pid}"
SUP_LOCK="${AURIGA_SUPERVISOR_LOCK:-$(dirname "$PIDFILE")/auriga-supervisor.lock}"
ROUTER_LOG="${ROUTER_LOG:-}"
SUP_LOG="${SUP_LOG:-}"
INTERVAL="${AURIGA_SUPERVISOR_INTERVAL:-30}"

say() {
  if [ -n "$SUP_LOG" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$SUP_LOG"
  else
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) supervisor: $*" >&2
  fi
}

# supervisor single-instance, via flock rather than a PID file. A PID file
# survives a container restart (the writable layer persists across `docker
# restart`, only PIDs reset), so a stale PID can collide with the new boot's
# own PID 1 and make the guard believe a dead supervisor is still running,
# permanently wedging the container in a restart loop. flock's lock is held
# by an open file descriptor, which the kernel releases the instant the old
# process (and its whole PID namespace) is gone -- immune to PID reuse.
if ! command -v flock >/dev/null 2>&1; then
  echo "supervisor: flock not found (util-linux / busybox flock required)" >&2
  exit 1
fi
exec 9>"$SUP_LOCK"
if ! flock -n 9; then
  echo "supervisor already running; exiting" >&2
  exit 3
fi

say "supervisor start pid=$$"
while true; do
  # is the router alive (per its pidfile)?
  alive=0
  if [ -f "$PIDFILE" ]; then
    rp=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$rp" ] && kill -0 "$rp" 2>/dev/null; then alive=1; fi
  fi
  if [ "$alive" -eq 0 ]; then
    say "router not alive; starting"
    if [ -n "$ROUTER_LOG" ]; then
      nohup "$NODE" "$ROUTER" "$@" >> "$ROUTER_LOG" 2>&1 9>&- &
    else
      "$NODE" "$ROUTER" "$@" 9>&- &
    fi
    say "started router pid=$!"
  fi
  sleep "$INTERVAL"
done
