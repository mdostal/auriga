#!/usr/bin/env bash
# Auriga one-command installer.
#
#   curl -fsSL https://mdostal.github.io/auriga/install.sh | bash
#
# This is the CANONICAL copy -- it lives in the repo at docs/install.sh and is
# published as-is via GitHub Pages, served straight from /docs on `main`
# (any push to main goes live immediately -- no separate gh-pages branch or
# publish workflow, unlike some sibling Pantheon repos). If you're editing the
# published copy directly, edit here instead and re-publish.
#
# Installs the Auriga router + CLI, then wires it into whatever AI coding
# agent CLIs are already on this machine (Claude Code, Codex CLI today) --
# `auriga agent init` owns that part and is idempotent, safe to re-run.
#
# Not on npm yet -- plain "auriga" there is an unrelated, unmaintained
# package (an isomorphic toolkit, nothing to do with Pantheon). This installs
# straight from GitHub via `git clone` + `npm link` until a real npm release
# ships under `pantheon-auriga` (the installed command would still just be
# `auriga`). No npm publish is required for this script to work.
set -euo pipefail

REPO_URL="https://github.com/mdostal/auriga.git"
INSTALL_DIR="${AURIGA_INSTALL_DIR:-$HOME/.auriga}"

# -- prerequisites -----------------------------------------------------------

for bin in git node npm; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: $bin is required and wasn't found on PATH." >&2
    exit 1
  fi
done

# Warn (don't silently clobber) if a DIFFERENT `auriga` is already on PATH --
# e.g. the unrelated npm package of the same name. A pre-existing symlink
# that already points into $INSTALL_DIR is just this script's own prior run
# and is fine.
if existing="$(command -v auriga 2>/dev/null)"; then
  resolved="$existing"
  if [ -L "$existing" ]; then
    resolved="$(readlink "$existing" 2>/dev/null || echo "$existing")"
  fi
  case "$resolved" in
    "$INSTALL_DIR"*) ;; # ours (or about to be) -- nothing to warn about
    *)
      echo "warning: a different 'auriga' command is already on PATH at $existing" >&2
      echo "         (resolves to: $resolved)" >&2
      echo "         continuing -- 'npm link' below may shadow it on PATH." >&2
      ;;
  esac
fi

# -- clone (or update) --------------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "-- updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" reset --quiet --hard origin/main
elif [ -e "$INSTALL_DIR" ]; then
  echo "error: $INSTALL_DIR already exists and isn't an Auriga git checkout." >&2
  echo "       remove it or set AURIGA_INSTALL_DIR to a different path and re-run." >&2
  exit 1
else
  echo "-- cloning auriga into $INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

# -- install + verify the router (the package that owns the `auriga` bin) ---

echo "-- installing router dependencies"
(cd "$INSTALL_DIR/src/router" && npm install)

echo "-- verifying the router (src/router: npm test)"
(cd "$INSTALL_DIR/src/router" && npm test)

# -- get `auriga` onto $PATH -------------------------------------------------
#
# No npm publish exists for this package yet (see header), so there's nothing
# to `npm install -g`. `npm link` from src/router/ is the standard Node
# mechanism for making a local package's `bin` entries resolve globally --
# this is the same mechanism already used to verify the CLI on this machine
# during development.

echo "-- linking the 'auriga' command onto \$PATH (npm link)"
(cd "$INSTALL_DIR/src/router" && npm link)

if ! command -v auriga >/dev/null 2>&1; then
  # npm's global bin dir may not be on PATH in this shell yet.
  export PATH="$(npm config get prefix)/bin:$PATH"
fi

if ! command -v auriga >/dev/null 2>&1; then
  echo "error: auriga installed but isn't on PATH." >&2
  echo "       add \"\$(npm config get prefix)/bin\" to your PATH and re-run." >&2
  exit 1
fi

# -- register with whatever agent CLIs are on this machine ------------------

echo "-- wiring up any agent CLIs already on this machine"
auriga agent init

echo
echo "Done. 'auriga' is installed at $INSTALL_DIR and linked onto \$PATH."
echo "Next: 'auriga agent status' any time to see what's registered, or"
echo "      https://github.com/mdostal/auriga#readme for the full picture"
echo "      (including how to build and run the operator dashboard, optional"
echo "      and not part of this install)."
