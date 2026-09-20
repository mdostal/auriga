#!/bin/zsh
# Install the auriga-supervisor launchd LaunchAgent so the router survives
# logout/reboot (PAN-7544). Idempotent: safe to re-run after editing the
# template or moving the checkout — it always reinstalls with fresh paths.
#
# Usage: ./install.sh
# Override NODE / DIR via env if your checkout or node install differs from
# the defaults baked into supervisor.sh.
set -eu

NODE="${NODE:-$HOME/.local/share/mise/installs/node/24.18.0/bin/node}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="${DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
LABEL="com.mdostal.auriga-supervisor"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ ! -x "$DIR/supervisor.sh" ]]; then
  echo "error: $DIR/supervisor.sh not found or not executable" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

sed -e "s#__NODE__#$NODE#g" -e "s#__DIR__#$DIR#g" -e "s#__HOME__#$HOME#g" \
  "$SCRIPT_DIR/$LABEL.plist.template" > "$PLIST_DST"

echo "installed $PLIST_DST"
echo "  NODE=$NODE"
echo "  DIR=$DIR"

UID_N="$(id -u)"
# Unload any prior instance first (bootout / legacy unload — either may be a
# no-op if nothing is loaded, so don't let it abort the install).
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST_DST" 2>/dev/null || true

launchctl bootstrap "gui/$UID_N" "$PLIST_DST" 2>/dev/null \
  || launchctl load -w "$PLIST_DST"

echo "loaded $LABEL — supervisor will now start at login and survive reboots."
echo "check status: launchctl print gui/$UID_N/$LABEL"
