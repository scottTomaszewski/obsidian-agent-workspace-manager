# Changes Panel — Per-Repo Checkout Selector — Design

**Date:** 2026-06-28
**Status:** Approved design, ready for implementation planning
**Scope:** Generalize the Changes panel from a task-only view into a **per-repo checkout
selector**, where each workspace repo's **main/base checkout is just another selectable
option** alongside that repo's task worktrees. Selecting any checkout opens the existing
detail view (working-tree commit/push + diff-vs-base review). Adds a changeable,
searchable **base-ref** control for the comparison. Closes the gap the prior changes
spec deferred ("A repos digest … in the overview",
`2026-06-27-task-changes-panel-design.md` § Out of scope).

## Summary

Today the Changes panel (`src/obsidian/changesView.ts`) has exactly two modes: with no
task selected it shows `renderOverview` (tasks grouped by state); with a task selected it
shows `renderTask` (Local / Unmerged tabs against `WorkspaceNote.baseBranch`). The
workspace's **main checkouts** — the real repos at `repo.path`, sitting on `baseBranch` —
are never shown, so changes made directly on `main` are invisible.

This design, guided by [Orca](https://www.onorca.dev/docs/model/worktrees)'s worktree
model, collapses "main vs task" into **one selectable list of checkouts**. The unifying
abstraction is a **checkout target**: a task worktree and a repo's main checkout are the
same kind of thing — a directory on a branch whose changes you can review, commit, and
push. The overview becomes a tree grouped by repo; each repo lists its main checkout
(`◆ main`) plus each task worktree (`○ DS-123 title`) as sibling rows. Clicking any row
drills into the existing detail view, generalized to render *any* target. A clickable
`vs <baseRef>` control (Orca's "base ref") lets the user change and pin what each repo is
compared against via a searchable branch picker; `main` is just its default.

The deliverable underneath the UI is the **`CheckoutTarget`** abstraction in pure core,
so the view, the commit coordinator, and the overview counts are all thin callers of one
model.

## Decisions (locked)

| Area | Decision |
|---|---|
| Unifying model | A **`CheckoutTarget`** `{ repo, path, branch, kind, taskId?, taskTitle?, defaultBaseRef }`; `kind: "base"` (repo main checkout) or `"worktree"` (task worktree) |
| Overview layout | **Master/detail tree** grouped by repo; `◆ main` + each `○ DS-123 title` are sibling rows with `● local ↑ vs-base` counts; click → drill into detail |
| Repo scope | **All workspace repos** (via new `VaultGateway.listWorkspaces()`), deduped by `repo.path`; main checkouts show even with zero tasks |
| Detail view | Existing two-tab view generalized from a `TaskNote` to a `CheckoutTarget`: **Local** (working tree) + **`vs <baseRef>`** (diff) |
| Default base ref | `kind: "base"` → **`origin/<baseBranch>`** (shows *unpushed* commits); `kind: "worktree"` → **`<baseBranch>`** (local, = today's Unmerged) |
| Base-ref control | Clickable `vs <baseRef>` → inline **searchable** branch picker (`GitBackend.searchBranches`); selection **pinned per repo**; "Use default" clears the pin |
| Base-ref persistence | Plugin settings `pinnedBaseRefs: Record<string, string>` keyed by **repo path** (`loadData`/`saveData`); no workspace-note edits |
| Commit/push routing | `kind: "worktree"` → `pushBranch`; `kind: "base"` → `pushBase`. Commit is checkbox-driven as today |
| Diff-tab actions | `kind: "worktree"` → Merge / Merge & Push / Open PR (unchanged); `kind: "base"` → **Push** only (no merge/PR) |
| Refresh | Manual button + render-time counts, as today; no new watcher |

## Why these choices

- **One abstraction, not a third mode.** A main checkout and a task worktree differ only
  in `kind`, default base ref, and push routing. Modeling both as a `CheckoutTarget`
  keeps the detail view, commit path, and counts identical for both — the smallest way to
  make "main is just another option" literally true (Orca's core insight: a checkout is
  the unit you select; main isn't privileged).
- **Per-kind default base ref.** A task worktree compared vs local `baseBranch` shows work
  ahead of base (today's behavior, preserved). A main checkout's interesting delta is
  *unpushed* commits, so it defaults to `origin/<baseBranch>`. Both are overridable via
  the picker, so neither default boxes the user in.
- **All workspace repos via `listWorkspaces()`.** Deriving repos from tasks alone would
  hide a repo's main changes whenever it has no active task — exactly the case the user
  wants visible. Listing workspaces is trivial (`filesOfType("workspace")` already
  exists) and dedupes naturally by `repo.path`.
- **Pin in plugin settings, keyed by repo path.** Orca pins the base ref per repo. OAWM
  has no per-repo store, and editing workspace notes for a transient view preference is
  heavy and surprising. The existing `loadData`/`saveData` settings bag keyed by absolute
  repo path is the lightest durable home and survives reloads.
- **Reuse the detail view and git primitives.** `status`, `commitPaths`,
  `branchDiffFiles`, `fileDiff`, `unmergedCounts`, `pushBranch`, `pushBase` all already
  take a path + base and work unchanged for any target. The only new git primitive is
  branch search.

## Architecture & Components

Layered like the rest of the codebase (pure core → ports → backend → view).

- **`src/core/targets.ts` (new, pure):**
  - `CheckoutTarget = { repo: string; path: string; branch: string; kind: "base" | "worktree"; taskId?: string; taskTitle?: string; defaultBaseRef: string }`.
  - `buildTargets(tasks: TaskNote[], workspaces: WorkspaceNote[]) → Map<string, CheckoutTarget[]>`
    — keyed by repo name, ordered `base` first then worktrees. For each workspace repo,
    emit a `base` target (`path = repo.path`, `branch = baseBranch`,
    `defaultBaseRef = "origin/" + baseBranch`), deduped by `repo.path`. For each task with
    a branch/worktree, emit a `worktree` target per `resolveTaskWorktrees(task, ws)`
    (`defaultBaseRef = ws.baseBranch`).
  - `resolveBaseRef(target, pinned: Record<string, string>) → string` — pinned value for
    the target's repo path, else `target.defaultBaseRef`.
  - No git, no Obsidian; fully unit-testable.

- **`src/core/ports.ts` (extend):**
  - `VaultGateway.listWorkspaces(): Promise<WorkspaceNote[]>`.
  - `GitBackend.searchBranches(repoPath: string, query: string, limit: number): Promise<string[]>`.

- **`src/backends/git.ts` (implement `searchBranches`):**
  `git for-each-ref --format=%(refname:short) refs/heads refs/remotes`, filtered by a
  case-insensitive substring of `query`, capped at `limit`. Returns `[]` on error (never
  throws to the UI), consistent with the other `GitBackend` methods.

- **`src/obsidian/vaultGateway.ts` (implement `listWorkspaces`):**
  map `filesOfType("workspace")` through `frontmatterToWorkspace`.

- **`src/core/commit.ts` (generalize `CommitCoordinator`):**
  Add `commitTarget(target, { paths, message, push }) → RepoResult[]` that commits
  against any checkout's `path` and routes push by `kind` (`pushBranch` vs `pushBase`).
  Extract the existing per-repo commit core so both `commit(task, …)` (used by the task-
  note action bar, unchanged) and `commitTarget` call it.

- **`src/obsidian/changesView.ts` (rework):**
  - State: replace `activeTaskPath: string | null` with
    `activeTarget: { repo: string; path: string } | null` (target identity).
  - `renderOverview` → repo-grouped collapsible tree of targets from `buildTargets`; each
    row shows `unmergedCounts(target.path, resolveBaseRef(target, pinned))`; click →
    `showTarget`.
  - `renderTask` → `renderTarget(target)`: **Local** tab (working-tree `status`,
    checkboxes + message + Commit / Commit & Push) and **`vs <baseRef>`** tab
    (`branchDiffFiles(path, baseRef)` rows + diff links). Diff-tab actions branch on
    `kind` (worktree → Merge / Merge & Push / Open PR; base → Push).
  - **Base-ref control:** a clickable `vs <baseRef>` button in the header → inline search
    input → `git.searchBranches` results → select pins via `deps.setBaseRef(repoPath,
    ref)`; a "Use default" calls `deps.setBaseRef(repoPath, null)`.
  - New deps: `getBaseRef(repoPath) → string | null`, `setBaseRef(repoPath, ref | null)`.

- **`src/main.ts` (wire):**
  - Settings: `pinnedBaseRefs: Record<string, string>` (default `{}`).
  - Pass `getBaseRef`/`setBaseRef` (read/write the map + `saveData`) and the generalized
    commit path into `ChangesView`.
  - `activateChanges` continues to accept an optional task path → resolves to that task's
    worktree target for the primary repo (deep-link from the action bar / dashboard).

- **`tests/fakes.ts` (extend):** `FakeVault.listWorkspaces()` (returns seeded
  workspaces); `FakeGit.searchBranches(repoPath, query, limit)` (filters a seeded branch
  list), keeping both fakes satisfying their interfaces.

## Overview UX (master, no checkout selected)

- **Header:** `Workspace Changes` + refresh.
- **One collapsible group per repo** (`▾ acme-web`), repos deduped across workspaces.
- **Rows within a repo:** `◆ main` first, then `○ DS-123 add-auth` per task worktree.
  Each row shows `● <local> ↑ <vs-base>` counts (`unmergedCounts(path, baseRef)`), where
  `baseRef` is the resolved (pinned-or-default) ref for that target.
- **Click a row → `showTarget`** drills into the detail view; a back/▲ control returns.
- Empty: a repo with no worktrees still shows its `◆ main` row; no workspaces → "No
  workspaces found."

## Detail UX (a checkout selected)

- **Header:** `▲ <label> · <branch>` where label is `main` (base) or `DS-123 — title`
  (worktree), plus a refresh button and the **`vs <baseRef>`** control.
- **`vs <baseRef>` control:** shows the resolved ref; click → inline search input
  (`Search branches…`) → debounced `git.searchBranches` → pick to pin → re-render. A
  "Use default" link appears when a pin is active and clears it.
- **Tabs:** `Local · <n>` and `<baseRef> · <n>` with live counts; remember last tab per
  target.
- **Local tab:** per-repo file rows with checkboxes (= include in commit), shared commit
  message, **Commit & Push** / **Commit** (disabled until ≥1 checked + non-empty
  message). Push routes by `kind`.
- **Diff tab:** read-only file rows + diff links (`fileDiff(path, baseRef, file,
  "branch")`). Bottom actions by `kind`: worktree → Merge / Merge & Push / Open PR
  (delegating to `CompletionCoordinator`, unchanged, incl. the multi-repo caveat note);
  base → **Push** (`pushBase`). After a worktree finishing action completes the task,
  return to the overview.
- **States:** Local empty → "No local changes"; Diff empty → "No changes vs `<baseRef>`".
  Git errors surface inline via `Notifier`, never thrown.

## Data flow

1. Open panel → `buildTargets(listTasks(), listWorkspaces())` → render repo tree; counts
   via `unmergedCounts(path, resolveBaseRef(target, pinned))` per row.
2. Select target → `renderTarget` → `status(path)` (Local) + `branchDiffFiles(path,
   baseRef)` (Diff).
3. Change base ref → `searchBranches` → `setBaseRef(repoPath, ref)` → persist → re-render
   (counts and diff recompute against the new ref).
4. Commit/push → generalized `CommitCoordinator` (push by `kind`). Merge/PR (worktree) →
   `CompletionCoordinator`. Push (base) → `pushBase`.

## File structure

- **New:** `src/core/targets.ts`.
- **Modified:** `src/core/ports.ts` (`listWorkspaces`, `searchBranches`),
  `src/backends/git.ts` (`searchBranches`), `src/obsidian/vaultGateway.ts`
  (`listWorkspaces`), `src/core/commit.ts` (target-based commit),
  `src/obsidian/changesView.ts` (overview tree + target detail + base-ref control),
  `src/main.ts` (settings + deps), `tests/fakes.ts` (extend `FakeVault`/`FakeGit`).

## Testing

Mirrors the existing `tests/` split (pure → fakes → real-git contract → manual). TDD the
pure pieces first per the project convention.

- **Pure (`targets.ts`):** `buildTargets` emits a `base` target per repo + a `worktree`
  target per task worktree, ordered base-first; dedupes repos shared across workspaces by
  `repo.path`; per-kind `defaultBaseRef` (`origin/<base>` vs `<base>`); handles zero
  tasks (base targets only) and tasks without a branch/worktree (skipped).
  `resolveBaseRef` returns the pin when present, else the default.
- **`CommitCoordinator` (fakes):** target-based commit hits the target's `path`; push
  routes to `pushBranch` for `kind: "worktree"` and `pushBase` for `kind: "base"`;
  empty-selection / empty-message no-op; per-repo results preserved (no cross-repo
  rollback), consistent with the existing commit tests.
- **`GitBackend.searchBranches` (real temp repo):** returns local + remote refs matching
  the query (case-insensitive substring), respects `limit`, returns `[]` for no match and
  on error.
- **`FakeVault.listWorkspaces` / `FakeGit.searchBranches`:** satisfy the ports and return
  seeded data.
- **Manual (append to `docs/MANUAL-TEST.md`):** main-checkout row appears per repo and
  drills in; committing/pushing directly on a base checkout; changing the base ref via
  the searchable picker and seeing counts/diff update; the pin persisting across an
  Obsidian reload; base-checkout Diff tab shows Push (not Merge/PR).

## Docs sync (part of done)

- **ARCHITECTURE.md:** module map gains `src/core/targets.ts`; note the changes-ingest /
  panel flow now renders any `CheckoutTarget`, and the new `listWorkspaces` /
  `searchBranches` ports.
- **docs/gotchas.md:** base-ref default differs by kind (`origin/<base>` for base
  checkouts vs local `<base>` for worktrees); repo dedup by `repo.path`; pin persisted in
  plugin settings keyed by absolute repo path.
- **CHANGELOG.md:** an `## Unreleased` bullet for the per-repo checkout selector + main
  changes.
- **ROADMAP.md:** if the base-ref picker ships limited, record any follow-up; otherwise
  mark the deferred "repos digest" item closed.

## Out of scope

- Orca's worktree **creation** start-from picker (choosing a branch/SHA to branch *from*
  at create time) — this spec covers viewing/reviewing existing checkouts only.
- Multi-repo merge/completion (still primary-repo only; tracked in ROADMAP § 1).
- Inline diff comments / "ship back to agent", attribution, and other Orca review
  features.
- Native in-Obsidian editing of out-of-vault files (deferred by the prior changes spec).
- Cross-checkout bulk commit; filesystem watcher / live auto-refresh.
- `gh`/`glab` CLIs and platform APIs (raw `git` only).
