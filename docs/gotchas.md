# Gotchas & non-obvious decisions

Funky logic that is invisible from a quick read. Each entry says *why* it exists so a
future change doesn't "simplify" it back into a bug.

## Worktrees live OUTSIDE the Obsidian vault

Per-task git worktrees are created at `<repo>/.oawm-worktrees/<dir>` — under the *repo*,
not the vault. They are **not** vault files. Never open or read them through Obsidian's
Vault API / `TFile`; read their contents via git (`GitBackend.fileDiff`/`status`) and
render in our own views (`DiffView`, `ChangesView`). `OawmPlugin.openTask` uses `TFile`
*only* for the task note itself, which does live in the vault.

- Worktree dir = `slugify(id)-slugify(title)` (`worktreeDirName`, `src/domain/types.ts`)
- Branch = `oawm/<dir>` (`branchName`)

## Base branch is per-task and base-agnostic — never assume `main`

Every git operation that needs a base reads `WorkspaceNote.baseBranch`. Do not hardcode
`main`/`master` anywhere. `branchDiffFiles`/`fileDiff`/`unmergedCounts`/merge all take a
`base` argument threaded from `ws.baseBranch`.

## `waitForSession`: zellij registers the session asynchronously

`src/core/orchestrator.ts` — after `agent.launch(...)` resolves, the terminal has been
spawned but zellij may not have *registered* the session yet. If we wrote `Running`
immediately, the very next liveness check could see `isAlive=false` and race the task to
`Failed`. So `launch` polls `isAlive` for up to 8s (`waitForSession`) before writing
`Running`; if it never appears, it writes `Failed` ("session did not start").

## StatusIngest guards `Waiting` from clobbering `NeedsReview`

`src/core/statusIngest.ts` — Claude Code fires a `Notification` hook (→ `Waiting`) when
it goes idle, which can land **~60s after** the `Stop` hook that already set
`NeedsReview`. Without the guard, the late `Waiting` would downgrade a review-ready task.
So ingest drops a `Waiting` marker when the task is already `NeedsReview`.

## The hook helper is embedded in the bundle and written to disk on load

`src/hookScript.ts` holds the `oawm-hook.mjs` source as a string. `OawmPlugin.onload`
writes it next to the plugin (`<plugin dir>/oawm-hook.mjs`) every load. This guarantees
it is present and version-matched with no separate install step, and self-heals a deleted
file. Claude Code hooks invoke it with `<event> --task <id> --status-dir <dir>`; it writes
a durable marker `<vault>/.oawm/status/<task>.json`.

## Status pipeline is fsWatch + a 15s sweep (durable markers, not events)

Markers are the source of truth, not the fsWatch events. `fsWatch` gives low-latency
ingest, but events can be dropped or fire while the plugin is closed. The 15s sweep
(`OawmPlugin.sweep` → `selfHealFromMarker`) re-reads each `Running` task's marker file and
re-ingests it, so state self-heals from the durable file regardless of missed events.
`StatusIngest.ingest` is idempotent (no-ops when the parsed state equals the current
state).

## Per-task reconcile is serialized with a promise-chain lock

`Orchestrator.reconcileTask` keeps a `Map<path, Promise>` and chains each reconcile after
the previous one for the same task path, so concurrent triggers (note edit + sweep + hook
ingest) can't interleave mid-reconcile for one task.

## zellij path must be resolvable for non-interactive processes

The plugin launches zellij from a non-interactive context, so a shell alias in
`~/.bashrc` is invisible. The "Zellij path" setting must be an absolute path or a binary
on the system `PATH`. Same constraint applies to the terminal command.

## Editor command: `{file}` is shell-quoted, `{line}` is raw

`buildEditorCommand` (`src/core/editorOpen.ts`) POSIX-single-quotes the `{file}`
substitution (so paths with spaces/metachars survive `bash -lc`), and leaves `{line}`
raw (it's a number). See FOLLOWUPS #2 — `{line}` is currently always `1`.

## Merge/completion is single-repo; commit is multi-repo

See ROADMAP #1. `CommitCoordinator` is multi-repo; `CompletionCoordinator` (merge / push
/ PR) acts only on the primary repo. The Changes panel surfaces a caveat for multi-repo
tasks.

## GitBackend methods return result objects and tolerate non-zero exits

`GitBackend` methods never throw to the UI — they return `{ ok, ... }` style results or
empty data. A few read paths intentionally swallow non-zero git exits (e.g. `status`
returns `[]`, `getRemoteUrl` returns `""`), matching the existing tolerant pattern. The
Notifier surfaces user-facing outcomes.

## Side-by-side diff is derived from the unified diff string, not a second git call

`buildSideBySide` (`src/obsidian/diffPanel.ts`) reconstructs two columns from the same
unified diff the unified view uses — there is no separate `git diff` invocation. Within a
hunk it buffers consecutive `-` lines (left) and `+` lines (right) and zips them row-by-row
on the next context line or hunk boundary (`flush()`); the shorter side gets `null` cells.
Line numbers seed from the `@@ -old +new @@` header. Two non-obvious skips: lines starting
with `\` (the "No newline at end of file" marker) and a trailing empty string from
`split("\n")` are dropped so they don't create phantom rows or mis-number columns.

Side-by-side has **two different DOM layouts** picked by the Wrap pref (`renderSxsGrid` vs
`renderSxsPanes` in `diffView.ts`) — not one structure with a CSS toggle. This split is
deliberate:

- **Wrap ON** → one 4-column CSS grid (`.oawm-diff-sxs`). A row's left+right cells share the
  same grid row track, so when a long line wraps to N lines both sides grow to the same
  height and stay aligned. Text columns are `minmax(0,1fr)` + cells `min-width: 0` so they
  wrap at ~50% instead of overflowing.
- **Wrap OFF** → two panes (`.oawm-diff-sxs-panes` → `.oawm-diff-pane` × 2), each its own
  `overflow-x: auto` scroller, so a whole side scrolls horizontally **as one unit** rather
  than each line being its own scroll block. This only stays row-aligned because every row
  is exactly one line tall: the two panes get the same number of equal-height rows (meta
  rows and null/empty cells included), so row *i* lines up across panes by position. Line
  numbers are `position: sticky; left: 0` so they stay visible while the pane scrolls.

You can't get both behaviors from a single grid: a grid gives shared row heights (needed for
wrap) but can't make a subset of columns scroll together (needed for per-side scroll). Hence
the two renderers. See `styles.css`.

**Horizontal scrollbars need explicit width constraints** — two non-obvious bits in
`styles.css` without which the scrollbar silently never appears:
- `.oawm-diff-pane` needs `min-width: 0`. It's a `1fr` grid item, and grid items default to
  `min-width: auto` (won't shrink below content), so the track would grow to the widest line
  and the grid overflows (clipped) instead of the pane scrolling at 50%.
- The no-wrap unified `<pre>`'s line `<div>`s get `width: max-content` (scoped to
  `:not(.oawm-diff-wrap)`). Block children otherwise stay `<pre>`-width and their inline
  overflow doesn't reliably extend the `<pre>`'s scroll width, so no scrollbar. (Scoped away
  from wrap mode, where `max-content` would defeat wrapping.)
