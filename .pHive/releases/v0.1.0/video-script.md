# Auriga v0.1.0 — short demo script

**Hook (0:00-0:10)**
"This is Auriga — an orchestrator that decides what work goes where, and it just
became a real, installable tool instead of one repo's internal router."

**What it does (0:10-0:30)**
Show the dashboard: epics list -> click into an epic -> story detail with its
dependency view -> activity log. "This is Auriga watching a real board and showing you
exactly what it's doing — no raw YAML required."

**Install + interact (0:30-0:55)**
Run `curl -fsSL https://mdostal.github.io/auriga/install.sh | bash` in a terminal.
Then `auriga agent init`. Then, from a Claude Code session: ask it "what's blocked on
the board right now" and show the real MCP tool call round-trip answering it.
"One install command, and your own agent session can talk to Auriga directly."

**The registry (0:55-1:10)**
`auriga project list` — show the real registered projects. "Adding a new project used
to mean editing source code. Now it's one command."

**Close (1:10-1:20)**
"Auriga runs standalone today — zero required external systems — and this is the
first release where anyone else can actually run it. Repo's linked below."
