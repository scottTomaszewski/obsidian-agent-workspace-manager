# Roadmap

<!-- next-id: 3 -->

New features and larger planned / in-flight efforts. Add a numbered `## N.` section
below (take N from `next-id` above, then increment it). Small in-scope tangents off
the *current* task go in FOLLOWUPS.md, not here.

Numbers are permanent: never reused, never renumbered. Done items get pruned to
`docs/roadmap-archive/` keeping their original number as a `(was ROADMAP #N)` handle,
so gaps in the live list are normal.

The broad product vision (execution profiles, SSH/Docker hosts, multiple providers,
conversations, dependency resolution, etc.) lives in [idea.md](idea.md) — that is the
aspirational spec, not committed work. Promote an item here only when it becomes a
concrete planned effort.

<!-- Template — copy for each item; take N from next-id above, then bump next-id:
## N. Short title
**Status:** planned
What the effort is and why. Link to a plan/spec doc under docs/superpowers/ once one exists. -->

## 2. tmux MuxBackend adapter

**Status:** planned

Add a `TmuxBackend` implementing the existing `MuxBackend` port
(`new-session`/`attach-session`/`list-sessions`/`kill-session`/`split-window`) so tmux
can be selected alongside zellij. Because the `TerminalLauncher` seam already decouples
session creation from the terminal host, this composes with the embedded xterm.js
terminal with no further changes to the embedded-terminal path.

## 1. Multi-repo merge / completion

**Status:** planned

Today the **commit** path is genuinely multi-repo (`CommitCoordinator` commits and
pushes each of a task's repos), but the **merge/completion** path is single-repo:
`CompletionCoordinator.merge` / `pushBranch` / `openPr` operate only on the task's
*primary* repo (`task.worktree` and `resolveRepoPath` = `task.repositories[0]`). The
Changes panel's Unmerged tab now lists committed files across *all* of a task's repos,
which newly surfaces this gap — so the panel shows a caveat note when a task spans more
than one repo (see `renderUnmerged` in `src/obsidian/changesView.ts`) and
[docs/MANUAL-TEST.md](docs/MANUAL-TEST.md) documents the limitation.

Effort: make `CompletionCoordinator` iterate `resolveTaskWorktrees(task, ws)` (like
`CommitCoordinator` does) so merge / fast-forward-base / push / PR run per repo, with
per-repo results and no cross-repo rollback. Until then, merging a multi-repo task
integrates only its primary repo.
