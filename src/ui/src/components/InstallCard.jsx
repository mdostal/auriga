import { useState } from 'react'

// Dismissible "install & interact" card, shown at the top of App.jsx's
// header — the first thing a first-time visitor to the dashboard sees, per
// p5-install-ui-surfacing. Confirmed by research: no dismiss/collapse/
// localStorage pattern exists anywhere else in src/ui/src/, so this is
// net-new, not an extension of something that already exists.
//
// The install command below is the REAL one-liner from docs/install.sh
// (published via GitHub Pages as of p5-install-script) — not a placeholder.
// `auriga agent init` (invoked by that script) is what actually registers
// the MCP server with whatever agent CLI is on the machine, which is why
// the description below names it explicitly rather than being vague about
// "installing a CLI".
const INSTALL_COMMAND = 'curl -fsSL https://mdostal.github.io/auriga/install.sh | bash'

const STORAGE_KEY = 'auriga.installCard.dismissed'

function readDismissed() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // localStorage can throw (private browsing, disabled storage, etc.) —
    // fail open by treating the card as not-dismissed rather than crashing
    // the whole header.
    return false
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // Best-effort only — if storage isn't writable the card just reappears
    // on next load, which is a safe degradation, not a functional break.
  }
}

export default function InstallCard() {
  const [dismissed, setDismissed] = useState(readDismissed)

  if (dismissed) return null

  return (
    <div className="mb-6 rounded-md border border-capella-line bg-capella-soft px-5 py-4 relative">
      <button
        type="button"
        aria-label="Dismiss install card"
        onClick={() => {
          writeDismissed()
          setDismissed(true)
        }}
        className="absolute top-3 right-3 text-ink-3 hover:text-ink-1 font-ui text-lg leading-none w-6 h-6 flex items-center justify-center rounded transition-colors"
      >
        ×
      </button>
      <p className="font-ui text-[11px] tracking-[0.2em] uppercase text-capella mb-2 pr-8">
        Install &amp; interact
      </p>
      <pre className="font-mono text-[12.5px] text-ink-1 bg-panel border border-hairline-soft rounded-sm px-3 py-2 mb-2 overflow-x-auto whitespace-pre">
        {INSTALL_COMMAND}
      </pre>
      <p className="text-xs text-ink-2 max-w-[60ch]">
        Installs Auriga&apos;s CLI and registers an MCP server so your own Claude Code /
        Codex session can query this board directly.
      </p>
    </div>
  )
}
