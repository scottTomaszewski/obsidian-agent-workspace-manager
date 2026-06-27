# Task Changes Panel — Design

**Date:** 2026-06-27
**Status:** Approved design, ready for implementation planning
**Scope:** A task-scoped **Changes** panel — the "code-review / merge-landing zone" (view #4 of the eventual kanban → task-details → terminal → review set). A persistent right-sidebar view with a Workspace Overview home state and a per-task drill-in showing working-tree changes (commit & push, IntelliJ-style, multi-repo) and committed branch-vs-base changes (review + land). Replaces the blocking `DiffModal` with a non-blocking popout diff view. Builds on raw `git` and the existing coordinator layer.

## Summary

This is the "separate, larger design" deferred by the task-completion spec (`2026-06-27-task-completion-git-actions-design.md`): the IntelliJ-style staged/unstaged changes tool window plus committing.

The panel is a persistent Obsidian `ItemView` in the right sidebar. With no task drilled in it shows a **Workspace Overview** — a git-flavored digest of every active task in the current workspace. Drilling into a task shows two tabs: **Local** (working-tree changes — the commit & push surface) and **Unmerged** (committed `base...HEAD` changes — the review surface, which also hosts the existing Merge / Merge & Push / Open PR actions). Clicking a file opens its diff in a separate popout window so it can be read alongside code in the main window; a per-file ✎ affordance opens the file in a configurable external/terminal editor.

Committing is checkbox-driven (checkbox = include in commit; git staging hidden) and spans all of a task's repos with one shared message. The real deliverable underneath the UI is a **surface-agnostic action layer** so the panel, the existing task-note action bar, and a future kanban tile are all thin callers of the same coordinators.

## Decisions (locked)

| Area | Decision |
|---|---|
| Panel identity | Task-scoped **Changes** panel = the code-review/merge landing zone (view #4); persistent right-sidebar `ItemView` |
| Home / no-task state | **Workspace Overview**: active tasks in the current workspace with local/unmerged counts; click to drill in |
| Per-task layout | Two tabs: **Local** (working tree) and **Unmerged** (committed `base...HEAD`) |
| Base | Per-task, base-agnostic (default `main`, click-to-edit in the header for epics/long-lived worktrees) |
| Diff display | Click a file → diff opens in a non-blocking **popout window** (default) or main split (setting); replaces `DiffModal` |
| Staging model | Checkbox = **include in commit**; git staging hidden (`git add` the checked paths at commit time) |
| Multi-repo commit | **Full multi-repo, shared message**: one commit per repo with checked files, push each, per-repo result reporting, no cross-repo rollback |
| Merge/land | Unmerged tab hosts **Merge / Merge & Push / Open PR**, delegating to the existing `CompletionCoordinator` |
| Action layer | Surface-agnostic coordinators; existing task-note action bar left as-is |
| Editor open (✎) | Configurable **mux pane** (default, remote-friendly) or **external command**, with `{file}`/`{line}`; native in-Obsidian editing deferred |
| Refresh | Manual button + refresh on focus; no filesystem watcher (YAGNI) |

## Why these choices

- **Task-centric, not workspace-wide commit.** OAWM is task-centric (`idea.md`); the panel scopes to one task's worktree(s). The Workspace Overview gives the at-a-glance multi-task/multi-repo picture without a confusing dual "mode" — it's root-vs-leaf, like a file tree.
- **Base-agnostic** so epics/subtasks (a subtask's base is the epic's branch, not `main`) work without special UI; nothing assumes `base == main`.
- **Popout diff, not modal.** A blocking modal can't be read while referencing code in the main window; a popout `ItemView` can.
- **Checkbox = include in commit** matches the IntelliJ habit and is the simplest mental model; staged-ness shows as a per-file badge, not a separate group.
- **External/terminal editor, not native.** Worktrees live at `<repo>/.oawm-worktrees/<dir>`, generally outside the vault and often on a remote host. Obsidian's editor surfaces are vault-bound (`TFile`/Vault API is vault-relative); community code-editor plugins inherit that and cannot open out-of-vault paths. The `Adapter`/`FileSystemAdapter` API can read absolute paths but yields no editor view. So native editing is deferred; the diff view (which already reads out-of-vault content via git and renders it natively) lays groundwork for a possible future native editor.

## Architecture & Components

Layered like the rest of the codebase (pure logic → ports → backend, mirroring `completion.ts` / `git.ts` / `ports.ts`).

- **`GitBackend` — new working-tree primitives** (extend the port rather than shelling ad-hoc in views):
  - `status(worktreePath) → FileChange[]` — parse `git status --porcelain=v2`.
  - `commitPaths(worktreePath, paths, message) → { ok, message, commit? }` — `git add -- paths` then `git commit -m msg -- paths`.
  - `branchDiffFiles(worktreePath, base) → FileChange[]` — file set for `base...HEAD`.
  - `fileDiff(worktreePath, base, path, scope: "worktree" | "branch") → string` — per-file unified diff.
  - `unmergedCounts(worktreePath, base) → { local: number; unmerged: number }` — counts for the overview (`git status` count + `git rev-list --count base..HEAD`).
  - Reuse existing `pushBranch`, `mergeBaseIntoBranch`, `fastForwardBase`, `removeWorktree`, `getRemoteUrl`.

- **`src/core/changes.ts` (pure):** the `FileChange` model (`{ path, repo, index, worktree, kind: "M"|"A"|"D"|"R"|"?" }`), the `parseStatus(porcelain) → FileChange[]` parser, `groupByRepo`, badge mapping, select-all tri-state derivation. No git; fully unit-testable.

- **`src/core/worktrees.ts` (pure-ish):** `resolveTaskWorktrees(task) → { repo, path }[]` — multi-repo resolution (today's completion code resolves only the first repo). Used by both coordinators and the panel.

- **`src/core/commit.ts` — `CommitCoordinator`:** constructed with `{ vault, git, notifier }`. Method `commit(task, { paths, message, push }) → RepoResult[]`. Resolves all worktrees, partitions checked paths per repo, commits/pushes each independently, returns per-repo results.

- **`src/core/editorOpen.ts` (pure) + execution:** `buildEditorCommand(template, { file, line }) → argv`. Execution via `MuxBackend` (new pane in the task session) or a new external-exec path, selected by setting.

- **Obsidian views:**
  - `src/obsidian/changesView.ts` — `ChangesView` (`ItemView`, right sidebar): overview ↔ task drill-in, the two tabs, file lists, commit surface, action buttons.
  - `src/obsidian/diffView.ts` — `DiffView` (`ItemView`) replacing `DiffModal`; opens in a popout leaf (default) or main split. Reuses `splitDiffLines` from `diffPanel.ts` (kept as pure helper).

- **Settings (new):** `editorStrategy: "mux" | "external"` (default `mux`), `editorCommand` (default `nvim +{line} {file}`), `diffTarget: "popout" | "split"` (default `popout`).

- **Surface-agnostic actions:** `ChangesView` calls `CommitCoordinator` (commit/push) and `CompletionCoordinator` (merge/land). The task-note action bar (`taskCodeBlock.ts`) is unchanged and calls the same coordinators.

## Workspace Overview (home / no-task state)

- **Workspace switcher** in the header (dropdown of the vault's workspaces; defaults to the last-viewed task's workspace, else last-used).
- **One row per active task** (any task with a branch/worktree), grouped by state in the dashboard's existing order (NeedsReview → Running → Waiting → Pending → Failed → Idle). Each row shows: task title · `branch → base` · **`● N local`** (uncommitted files) · **`↑ M unmerged`** (commits ahead of base) · state chip.
- **Click a row → drills into that task's Changes**; a back/▲ control returns to the overview.
- Read-only status + navigation only — **no cross-task bulk commit** (out of scope).
- Counts are computed async per worktree (`unmergedCounts`), shown with a spinner, refreshed on focus / manual refresh. Per-worktree git-call cost is acknowledged; keep it lazy (compute on render, not eagerly for hidden workspaces).

## Task drill-in UX

**Header.** `⚙ <task title> · <branch> → <base>` + refresh button + task switcher (dropdown of active tasks) + editor-strategy indicator. `→ base` is click-to-edit (writes the task's frontmatter `base`).

**Tabs.** `Local · <n>` and `Unmerged · <n>` with live counts; the panel remembers the last tab per task.

**File list (both tabs).** Files grouped under collapsible **per-repo headers** (`▸ web-app`). Each row: `[badge] path  ✎`, badge = M/A/D/R/? color-coded. Clicking the **path/row** opens that file's diff in the popout `DiffView` (Local → `scope: "worktree"`; Unmerged → `scope: "branch"`). Clicking **✎** opens the file in the configured editor. The open file is highlighted.

**Local tab — commit surface.** Each row has a **checkbox** (= include in commit). Per-repo header has a tri-state select-all. Below: a shared **commit message** textarea, then **`Commit & Push`** (primary) and **`Commit`** (secondary), disabled until ≥1 file checked and message non-empty. On success the list refreshes (committed files drop out) and the message clears.

**Unmerged tab — review surface.** Read-only file list (no checkboxes). At the bottom: **`Merge`**, **`Merge & Push`**, **`Open PR`** delegating to `CompletionCoordinator`. After a finishing action completes the task, the panel returns to the Workspace Overview.

**Diff popout (`DiffView`).** Non-blocking `ItemView`. Default `workspace.openPopoutLeaf()` (separate window); setting toggles to a main-area split. Title `path (Local|Unmerged)`. Re-clicking another file reuses the one diff leaf (no leaf pileup).

**States.** Empty: overview empty → "No active tasks in this workspace"; task tab empty → "No local changes" / "No unmerged changes (branch matches base)". Spinner while git runs. Git errors → inline notice, never thrown.

## Commit / Push flow (multi-repo, shared message)

`CommitCoordinator.commit(task, { paths, message, push })`:

1. `resolveTaskWorktrees(task)` → worktrees.
2. Partition checked `paths` by repo; skip repos with zero checked files.
3. Per repo with checked files: `commitPaths(worktree, repoPaths, message)`; if `push`, then `pushBranch(worktree, branch)`.
4. Collect `RepoResult[]` = `{ repo, committed, pushed, commit?, error? }`.

**Partial failure.** Repos are processed in sequence and are independent; one failing does **not** roll back or block others (git has no clean cross-repo transaction, and silently undoing a good commit is worse). Surface a single grouped notice, e.g. *"web-app: committed `a1b2c3`, pushed ✓ · api: commit failed — <git error>."* The panel refreshes: succeeded repos drop committed files; the failed repo keeps its changes and checkbox state for retry.

**Guards.** Nothing checked or empty message → buttons disabled (no-op). A checked file that vanished between render and commit → that repo reports a soft error; others proceed.

## Merge / land flow (Unmerged tab)

**Merge / Merge & Push / Open PR** delegate unchanged to the existing `CompletionCoordinator` (`merge`, `merge {push}`, `openPr`), inheriting:

- uncommitted-work warnings (finishing actions warn that uncommitted worktree changes will be discarded; confirm-to-proceed),
- conflict handling (conflict → `agent_state: NeedsReview`, worktree kept, "resolve in terminal, click Merge again"),
- fast-forward-only base advance (never disrupts the main checkout),
- teardown + state writes (`status: Completed`, clear branch/worktree/session) on success,
- Open PR returning `{ url? }` opened by `main.ts` via `shell.openExternal`.

After a task is completed by a finishing action, the panel returns to the Workspace Overview.

## Editor open (✎)

`buildEditorCommand(editorCommand, { file, line }) → argv`, then by `editorStrategy`:

- **mux:** `MuxBackend` opens a new pane in the task's existing session running the command (runs on the host where the worktree lives — remote-friendly).
- **external:** spawn the command as its own process (local GUI editors, e.g. `code -g {file}:{line}`).

A blank/missing template → notice pointing to the setting. Defaults: `mux`, `nvim +{line} {file}`.

## File structure

- New: `src/core/changes.ts`, `src/core/commit.ts`, `src/core/worktrees.ts`, `src/core/editorOpen.ts`, `src/obsidian/changesView.ts`, `src/obsidian/diffView.ts`.
- Modified: `src/backends/git.ts` + `src/core/ports.ts` (new `GitBackend` primitives), `src/obsidian/diffPanel.ts` (keep `splitDiffLines`, retire `DiffModal` once `DiffView` lands), `src/obsidian/taskCodeBlock.ts` / `src/obsidian/dashboardView.ts` (a "Review Changes" entry that opens the panel on a task), `src/main.ts` (register `ChangesView` + `DiffView`, settings, wire coordinators, open editor/PR URLs).

## Testing

Mirrors the existing `tests/` split (pure → fakes → real-git contract → view → manual).

- **Pure (no git):** `parseStatus` (staged/worktree/untracked, renames, deletes, kind mapping); `groupByRepo` / badge / select-all tri-state; `buildEditorCommand` (placeholders, blank template); overview row derivation (ordering + counts); `resolveTaskWorktrees` (single + multi-repo).
- **`CommitCoordinator` against fakes:** single-repo commit (exact paths + message), push variant calls `pushBranch`; multi-repo (one commit per repo, shared message, empty repos skipped); partial failure (A committed, B failed, no rollback, B state preserved); empty selection / empty message no-op. Assert exact backend calls and frontmatter writes.
- **`GitBackend` contract (real temp repos):** `status` (staged + unstaged + untracked + rename + delete); `commitPaths` (commits exactly the given paths, leaves other dirty files); `branchDiffFiles` / `fileDiff` (correct set + per-file diff for both scopes); `unmergedCounts`; `pushBranch` against a local bare remote.
- **View-level (jsdom, like `dashboard.test.ts`):** `ChangesView` empty state shows overview; task selection renders two tabs with counts; Local rows have checkboxes, Unmerged rows don't; commit buttons disabled until ≥1 checked + non-empty message; clicking a file requests a `DiffView` open with the right `{path, scope}`. `DiffView` renders `splitDiffLines` output and reuses one leaf across files.
- **Manual (irreducible — append to `docs/MANUAL-TEST.md`):** diff opening in a real popout window and the main-split setting; ✎ opening a real file in a zellij pane and via an external command; a real multi-repo Commit & Push across two worktrees.

## Out of scope

- Kanban view, task-note redesign / removing the codeblock action bar, terminal view (separate specs).
- Native in-Obsidian editing of out-of-vault files; symlink-into-vault workarounds.
- Cross-task bulk commit from the Workspace Overview.
- A repos digest (per-repo main-checkout dirty/ahead-behind) in the overview.
- Filesystem watcher / live auto-refresh.
- `gh`/`glab` CLIs and platform APIs (raw `git` only, consistent with the completion spec).
