# Architecture

The quickstart so a new agent doesn't have to re-scan the tree. For *why* odd code
exists, see [docs/gotchas.md](docs/gotchas.md). For the product vision (much of it not
yet built), see [idea.md](idea.md).

## Mental model

OAWM is an **Obsidian plugin** (desktop-only) that turns markdown task notes into a
**desired-state control plane** for Claude Code agents. There is **no daemon** — the
orchestrator runs in-process inside the plugin.

- A **task note** (frontmatter `type: task`) declares *desired* state (`status:
  Running`) and which workspace + repos it needs.
- The **Orchestrator** reconciles *actual* state: it launches `claude` in a per-task git
  worktree inside a zellij session, watches status, and offers merge/review.
- **Agent status** flows back through Claude Code hooks → a small embedded helper writes
  durable marker files → the plugin ingests them.

Two clean lines run through the code: **desired→actual reconcile** and **status ingest**.

## Layering (dependency direction points inward)

```
src/obsidian/*  Obsidian views + DOM + vault gateway   (outer; thin)
src/backends/*  real impls: git (exec), zellij, claude  (outer; side effects)
        │ both implement ports defined in ↓
src/core/*      coordinators + port interfaces          (inner; mostly pure)
src/domain/*    state model + reconcile decision        (innermost; pure)
src/main.ts     composition root: wires everything
```

**Ports/adapters:** `src/core/ports.ts` defines `VaultGateway`, `GitBackend`,
`MuxBackend`, `AgentBackend`, `Notifier`. Real adapters live in `src/backends/*` and
`src/obsidian/vaultGateway.ts`; test fakes live in `tests/fakes.ts`. Core logic depends
only on the interfaces, which is why most of it is unit-tested under node with no DOM.

**Testing split:** pure logic in `src/core/*` + `src/domain/*` is unit-tested; git
adapters get real-temp-repo contract tests (`tests/git.test.ts`); Obsidian `ItemView`
DOM is *not* unit-tested (node has no `document`) — it's thin and checked via
[docs/MANUAL-TEST.md](docs/MANUAL-TEST.md) + `npm run typecheck` + `npm run build`.

## Core flow 1 — desired → actual (reconcile)

1. User edits a task note's frontmatter (or clicks an action-bar button, or the 15s
   sweep fires).
2. `metadataCache "changed"` (in `main.ts`) → `Orchestrator.reconcileTask(path)`
   (serialized per path by a promise-chain lock).
3. `decide({desired, actual, sessionAlive})` (`src/domain/reconcile.ts`, pure) returns
   one action: `launch | markFailed | killAndIdle | offerMerge | none`.
4. `launch`: resolve workspace/agent → create worktree (`<repo>/.oawm-worktrees/<dir>`,
   branch `oawm/<dir>`) → `agent.launch` (claude in a zellij session) → `waitForSession`
   (8s poll, see gotchas) → patch task `Running` + branch/worktree/session.
5. `offerMerge` (desired `Completed`) → `CompletionCoordinator.merge`.

## Core flow 2 — agent status ingest

1. Claude Code fires hooks (`Stop`, `Notification`) → invokes the embedded
   `oawm-hook.mjs` → writes `<vault>/.oawm/status/<task>.json`.
2. `fsWatch` on the status dir **and** the 15s `sweep` both feed
   `StatusIngest.ingest(taskId, raw)`.
3. `parseMarker` maps `event` → `AgentState` (`waiting` → `Waiting`, `review` →
   `NeedsReview`); a guard prevents a late `Waiting` from clobbering `NeedsReview`.
4. Ingest patches the task's `agentState` and re-reconciles. Markers are durable, so
   state self-heals even if an fsWatch event was missed or the plugin was closed.

## Module map (one line each)

**domain (pure):**
- `domain/types.ts` — `TaskNote`/`WorkspaceNote`/`AgentNote`, state enums, `slugify`/`worktreeDirName`/`branchName`/`resolveRepoPath`.
- `domain/reconcile.ts` — `decide(...)`: the desired×actual×alive → action table.

**core (logic + ports):**
- `core/ports.ts` — the six backend interfaces (the seams): `VaultGateway`, `GitBackend`, `MuxBackend`, `AgentBackend`, `Notifier`, `PtyProvisioner`.
- `core/terminalBinary.ts` — pure provisioning helpers: `assetNameFor`, `downloadUrls`, `verifyChecksum`, `isInstalled`, `BinaryListing`.
- `core/orchestrator.ts` — reconcile loop, launch, liveness, per-task lock.
- `core/statusIngest.ts` — marker parse + agentState patch + clobber guard.
- `core/completion.ts` — `CompletionCoordinator`: merge / fast-forward base / push / open PR (single-repo; see ROADMAP #1).
- `core/commit.ts` — `CommitCoordinator`: multi-repo task commit & push (`commit`) and single-checkout commit & push (`commitTarget`, routes push by base/worktree).
- `core/changes.ts` — pure parsers (`parseStatus`/`parseNameStatus`) + `FileChange` + panel helpers (`groupByRepo`/`stampRepo`/`commitEnabled`/`selectAllState`).
- `core/worktrees.ts` — `resolveTaskWorktrees(task, ws)`: one `{repo, path, branch}` per declared repo.
- `core/targets.ts` — `buildTargets`/`resolveBaseRef`: a `CheckoutTarget` per repo base checkout + task worktree, grouped by repo; the changes panel's selectable units.
- `core/editorOpen.ts` — `buildEditorCommand` template substitution (`{file}` quoted, `{line}`).
- `core/remote.ts` — git remote URL → web compare/PR URL (GitHub/GitLab).

**backends (side effects):**
- `backends/exec.ts` — `run(...)` child-process wrapper (stdout/stderr/code).
- `backends/git.ts` — `RealGitBackend`: all git via `run` over raw `git` (no gh/glab).
- `backends/zellij.ts` — `ZellijBackend`: sessions + panes via the zellij CLI; accepts an injected `TerminalLauncher` seam that routes `create`/`focus` to either external zellij or the embedded terminal.
- `backends/pty.ts` — `PtyBackend`/`NodePtyHost`: node-pty loaded by absolute path from `<pluginDir>/node_modules/node-pty`; spawns a pty process and streams data to `TerminalView`.
- `backends/ptyBinary.ts` — `NodePtyProvisioner`: download node-pty zip from GitHub Release, SHA-256-verify against `checksums.json`, extract to `<pluginDir>/node_modules/node-pty`; implements `PtyProvisioner`.
- `backends/claude.ts` — `ClaudeBackend`: builds the claude launch command (hook env, status dir) and starts the session.
- `backends/terminal.ts` — terminal-command prefix handling.

**obsidian (UI):**
- `obsidian/vaultGateway.ts` — `ObsidianVaultGateway`: reads/patches task/workspace/agent notes via Obsidian APIs.
- `obsidian/dashboardView.ts` — workspace dashboard (`groupByState`), row → open note / Review.
- `obsidian/changesView.ts` — Changes panel: repo-grouped tree of checkout targets (main + worktrees), per-target Local/diff tabs, commit/diff/edit, changeable searchable base ref.
- `obsidian/diffView.ts` — `DiffView` ItemView + `openDiffLeaf` (popout/split, single reused leaf).
  Scalable toolbar with unified/side-by-side layout + line-wrap toggles, persisted via a
  `DiffPrefsGateway` wired to the `diffLayout`/`diffWrap` settings in `main.ts`.
- `obsidian/diffPanel.ts` — diff parsing: `classifyDiffLine`, `splitDiffLines` (unified),
  and `buildSideBySide` (two-column model). (+ legacy unused `DiffModal`.)
- `obsidian/taskCodeBlock.ts` — per-task action bar (`oawm-task` code block), action ids + labels.
- `obsidian/terminalView.ts` — xterm.js `ItemView`; one leaf per session, keyed by session id. Install flow: `TerminalView.status() → not-installed → in-pane prompt → install (fetch+verify+extract) → spawn`.
- `obsidian/embeddedTerminal.ts` — `EmbeddedTerminalLauncher`: `TerminalLauncher` implementation that opens/focuses `TerminalView` leaves.

**top level:**
- `main.ts` — composition root: settings (`terminalHost` selects external zellij vs embedded xterm.js), wires ports→coordinators→views including `NodePtyProvisioner`, hook helper write, status watcher + sweep, command/ribbon registration, action routing.
- `hookScript.ts` — embedded `oawm-hook.mjs` source (written to disk on load).
- `version.ts` — `VERSION` constant (kept in lockstep by `just release`).
