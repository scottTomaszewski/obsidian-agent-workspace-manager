# OAWM — Obsidian Agent Workspace Manager (POC Design)

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Scope:** Daily-driver proof-of-concept, primarily for the author; release later only if stable and broadly useful.

## Summary

OAWM is an Obsidian plugin that acts as a task-centric control plane for agentic software development. Markdown task notes express **desired state** (`status`); an in-plugin orchestrator reconciles **actual state** (`agent_state`) by launching and managing native Claude Code sessions in isolated git worktrees.

The defining constraint: **OAWM orchestrates *around* native Claude Code and never reimplements it.** Claude Code ships features rapidly; OAWM stays a launcher + workspace manager + status tracker so it never has to keep up with CC's internals.

## Locked-In Decisions

| Area | Decision |
|---|---|
| Run model | Interactive — launch real `claude` in a zellij pane you can jump into |
| Agent provider | Claude Code only (others deferred behind `AgentBackend` interface) |
| Host | Local filesystem only (SSH/Docker/devcontainer deferred) |
| Multiplexer | zellij (embedded terminal deferred behind `MuxBackend` interface) |
| Isolation | git worktree per task by default; `repo-direct` escape hatch per workspace |
| State feedback | Claude Code hooks → marker files → frontmatter; session-liveness backstop |
| Orchestrator location | In-plugin (Electron/Node), behind interfaces; daemon extraction is a later refactor |
| Account model | Agent = named, assignable account (maps to `CLAUDE_CONFIG_DIR`); assigned per-task |

## Architecture

Everything lives in the Obsidian plugin (Electron/Node), structured behind interfaces so a daemon extraction later is a refactor, not a rewrite.

```
Obsidian Plugin (Electron / Node)
│
├── Vault Layer        read/write/watch Task, Workspace, Agent notes
├── Orchestrator       reconciliation loop: desired (frontmatter) vs actual
├── Status Ingest      receives Claude Code hook callbacks → updates notes
└── Backends (interfaces)
      ├── GitBackend    worktree + branch lifecycle, diff, merge, guards
      ├── MuxBackend    zellij impl  (+ embedded-terminal impl later, same iface)
      └── AgentBackend  launches native `claude`, writes per-worktree hook config
```

The three backends are the only places tool-specific code lives. zellij, git, and Claude Code each sit behind one interface, each with a fake for testing.

### Key Flows

- **Launch:** desired `Running` → GitBackend creates worktree/branch → AgentBackend writes hook config + launches `claude` (with the assigned agent's `CLAUDE_CONFIG_DIR`) via MuxBackend in that worktree → actual `Running`.
- **Status:** CC `Notification`/`Stop` hooks run the `oawm-hook` helper, which writes a marker file → Status Ingest (fs watcher) maps it to the task → updates frontmatter.
- **Teardown:** desired `Cancelled`/`Completed` → MuxBackend kills session → GitBackend merges or removes worktree (with guards).

## Data Model

Markdown is the source of truth. All config is frontmatter; bodies are human/agent documentation. Three note types.

### Agent note (`Agents/vexa.md`) — the assignable account

```yaml
---
type: agent
provider: claude
account: { config_dir: ~/.claude-accounts/vexa }   # → CLAUDE_CONFIG_DIR at launch
---
```

An Agent is a named, assignable account. Multiple agents (e.g. multiple Claude Max plans) can coexist in one workspace and run in parallel, each launching `claude` with its own `CLAUDE_CONFIG_DIR`.

**Prerequisite:** OAWM does *not* manage Claude auth/login. The user sets up and logs into each `CLAUDE_CONFIG_DIR` once; OAWM only points `claude` at the right one.

### Workspace note (`Projects/Draw Steel/Draw Steel.md`) — the environment

```yaml
---
type: workspace
repositories:
  - { name: compendium, path: ~/code/compendium }
isolation: worktree          # worktree (default) | repo-direct
base_branch: main
git: { user: "Vexa", email: "vexa@example.com" }
mux: { backend: zellij }
host: { type: local }
env: {}
---
```

### Task note (`Projects/Draw Steel/Tasks/Add spell schema.md`)

```yaml
---
type: task
id: DS-123                   # stable task ID; routes hooks, names branch/worktree
workspace: Draw Steel
repositories: [compendium]
agent: vexa                  # ← assignment, per task
status: Pending              # ← DESIRED state, user edits this
priority: High
# --- system-managed below ---
agent_state: ""              # ← ACTUAL state, orchestrator writes
worktree: ""                 # path, orchestrator writes
branch: ""                   # orchestrator writes
session: ""                  # zellij session name, orchestrator writes
---
```

### Data-model decisions

1. **Desired vs actual are separate fields** (`status` = intent, `agent_state` = reality). The loop never fights the user's edits; both are always visible. Reconciliation = make `agent_state` match `status`.
2. **Agents are assigned per-task; environment lives on the workspace.** A task can run under a specific account without changing the workspace's git identity, host, or mux. Parallel tasks in one workspace can use different accounts.
   - **Task `id`** is user-supplied and stable. It routes hook callbacks (`--task <id>`, `<id>.json` marker), names the branch/worktree, and keys the per-task reconciliation lock. If omitted, the orchestrator derives a slug from the note filename and writes it back to `id` on first launch.
3. **Multi-repo tasks resolve to the first repo's worktree for the POC.** Unified multi-repo worktrees are deferred.

## Reconciliation Loop & State Machine

The orchestrator makes `agent_state` (actual) match `status` (desired). It is triggered by: (a) vault changes to a task note, (b) status-ingest marker files, (c) a periodic liveness sweep.

**Desired states** (user sets `status`): `Pending` → `Running` → `Completed` / `Cancelled`

**Actual states** (orchestrator/hooks set `agent_state`): `Idle` · `Running` · `Waiting` · `NeedsReview` · `Failed`

`Paused` is intentionally omitted from the POC (awkward semantics with an interactive session; YAGNI).

### Reconciliation rules

| desired | actual | action |
|---|---|---|
| `Running` | no live session | create worktree+branch → launch `claude` (agent's `CLAUDE_CONFIG_DIR`) → set actual `Running` |
| `Running` | session died unexpectedly | set actual `Failed` |
| `Cancelled` | live session | kill session, leave worktree (guard uncommitted work), set actual `Idle` |
| `Completed` | — | offer merge → on merge, remove worktree |
| `Pending` | anything | do nothing (not launched yet) |

`Waiting` and `NeedsReview` come **from hooks**, not from desired-state transitions — they describe what is happening inside a `Running` task. They drive UI badges/notifications and never trigger teardown.

**Concurrency:** reconciliation is serialized per-task via an in-memory lock keyed by task note path, so a rapid edit + hook callback cannot double-launch.

## Claude Code Hook Integration (Status Ingest)

CC reports its state via hooks; OAWM never parses CC's UI.

When launching a task, `AgentBackend` writes `.claude/settings.local.json` into the worktree with hooks wired to a tiny bundled helper, with the task ID baked into the command:

```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "oawm-hook waiting --task DS-123" }]}],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "oawm-hook review  --task DS-123" }]}]
  }
}
```

- The task ID is baked in at launch, so each worktree's hooks are self-identifying — no guessing which session fired.
- `oawm-hook` (shipped with the plugin) writes a marker file to `<vault>/.oawm/status/DS-123.json` containing `{ state, ts }`. No server, no ports — just a file write the plugin's fs-watcher already observes.

**Hook → state mapping for the POC:**
- `Notification` → `Waiting` (CC is asking something / waiting for input)
- `Stop` → `NeedsReview` (CC finished its turn — review the diff)

**Mapping back:** Status Ingest watches `.oawm/status/`, reads the marker, finds the task by ID, updates `agent_state` in frontmatter, fires a UI badge + optional Obsidian `Notice`.

**Liveness backstop:** the periodic sweep asks `MuxBackend` whether each task's zellij session is alive. Session gone while desired `Running` and last state ≠ `NeedsReview` → `Failed`. Catches crashes that fire no hook.

**Why marker files, not direct note writes:** keeping hooks dumb (one small file write) avoids races with Obsidian's own writes to the note and keeps the helper dependency-free. The plugin is the single writer of frontmatter.

## Obsidian UI Surface

Three surfaces, deliberately minimal.

1. **Task actions (in the task note).** An `oawm-task` code-block processor renders a state-aware action bar: `[ Start ] [ Open Terminal ] [ View Diff ] [ Cancel ] [ Complete & Merge ]`. `Start` flips `status: Running` (the loop does the rest); `Open Terminal` focuses the zellij session (`MuxBackend.focus`); `Cancel`/`Complete` flip desired state. A status badge shows `agent_state` (Running / Waiting / NeedsReview / Failed) with color.

2. **Workspace Dashboard (sidebar view).** All tasks grouped by `agent_state`, showing agent assignment and quick actions — the "control center." Click a task to open its note.

3. **Diff / Review (lightweight for POC).** `View Diff` runs `GitBackend.diff` (worktree branch vs base) in a syntax-highlighted panel. `Complete & Merge` merges the branch and tears down the worktree.

**Notifications:** when a task hits `Waiting` or `NeedsReview`, an Obsidian `Notice` + dashboard badge — the "an agent needs you" signal.

**Deferred (idea.md's richer review vision):** inline comments, per-file Accept/Reject, "Ask Agent" from a diff line. POC review loop = see the diff → jump into the terminal to iterate, or merge.

## Git Worktree Lifecycle

`GitBackend` owns all git; it is the only module that shells out to `git`.

**Naming.** For task `DS-123` ("Add spell schema") with base `main`:
- branch: `oawm/ds-123-add-spell-schema`
- worktree: `<repo>/.oawm-worktrees/ds-123-add-spell-schema/`

**Create** (on launch, `isolation: worktree`): `git worktree add -b <branch> <path> <base_branch>`. Record `worktree`, `branch`, `session` into frontmatter. If `isolation: repo-direct`, skip — run in the repo's working dir on its current branch; no branch created.

**Diff:** `git diff <base_branch>...<branch>` plus untracked files, for the review panel.

**Merge** (Complete & Merge): merge `<branch>` into `<base_branch>` in the main checkout; on success, `git worktree remove`. Merge conflicts → surface them, leave the worktree, flag for review; user resolves in the terminal. No auto-force, ever.

**Teardown guards:** `Cancel` and worktree removal **refuse to delete a worktree with uncommitted changes or unmerged commits** unless the user confirms a discard action. Silent loss of agent work is the worst failure mode; destructive git ops are always explicit.

**Repo hygiene:** `.oawm-worktrees/` and the vault's `.oawm/` status dir are added to a git exclude path so OAWM never pollutes the repo or commits status markers.

## POC Scope Boundaries

**In scope:**
- Workspace / Agent / Task notes with the schemas above
- In-plugin orchestrator + reconciliation loop (desired ↔ actual)
- `GitBackend` (worktree/branch/diff/merge + guards), `MuxBackend` (zellij: create/focus/kill/list), `AgentBackend` (launch native `claude` with `CLAUDE_CONFIG_DIR` + per-worktree hook config)
- `oawm-hook` helper + Status Ingest (marker files → frontmatter)
- UI: task action bar, workspace dashboard, lightweight diff/merge, Waiting/NeedsReview notices
- Per-task agent assignment; parallel tasks in one workspace, each its own account + worktree

**Deferred (post-POC):**
- Separate orchestrator daemon / RPC socket (refactor later behind the same interface)
- Remote/SSH/Docker/devcontainer hosts (local only)
- Embedded terminal backend (interface exists; only zellij implemented)
- Codex / Gemini / other providers (Claude Code only)
- Rich review editor (inline comments, per-file accept/reject, "Ask Agent")
- Multi-repo unified worktrees (POC uses first repo), task dependencies (`depends`), conversation persistence as notes, PR generation, CI monitoring, workspace snapshots
- Claude auth/login management (user pre-configures each `CLAUDE_CONFIG_DIR`)

## Testing Strategy

- **Unit (primary value):** orchestrator/reconciliation logic against fake GitBackend/MuxBackend/AgentBackend. Drive desired×actual combinations through the reconciliation table; assert correct backend calls + frontmatter writes. Pure logic, fast. TDD.
- **Backend contract tests:** GitBackend against a real temp git repo (worktree/diff/merge/guard paths) — TDD. MuxBackend zellij impl behind a thin seam, smoke-tested manually + fake for the rest.
- **Status Ingest:** feed marker files, assert frontmatter transitions.
- **Manual integration (one real end-to-end):** flip a task to `Running`; confirm `claude` launches in zellij under the right account, hooks flip Waiting/NeedsReview, diff + merge + teardown work. Documented as a checklist (touches real CC/zellij).

## Guiding Philosophy

Tasks are the permanent record; agents, terminals, worktrees, and sessions are transient execution details. The orchestrator reconciles the desired state expressed in markdown with the actual state of the environment, while staying agnostic to (and never reimplementing) the external tools it drives.
