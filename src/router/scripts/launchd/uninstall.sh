#!/bin/zsh
# Remove the auriga-supervisor launchd LaunchAgent installed by install.sh.
# Does NOT kill an already-running supervisor/router process (they self-heal
# via their own pidfile guards) — it only stops launchd from respawning them.
set -eu

LABEL="com.mdostal.auriga-supervisor"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_N="$(id -u)"

launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST_DST" 2>/dev/null || true

if [[ -f "$PLIST_DST" ]]; then
  rm -f "$PLIST_DST"
  echo "removed $PLIST_DST"
else
  echo "$PLIST_DST not present — nothing to remove"
fi
