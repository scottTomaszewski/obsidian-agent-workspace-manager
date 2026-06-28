# Changelog

All notable changes to this project are documented in this file. The
"Unreleased" section is promoted to a version heading by `just release`, and its
body becomes that release's GitHub notes.

## Unreleased

- The **"Diff window"** setting gained a **New tab** option — open diffs in a tab alongside
  your notes, in addition to the existing popout window and main split.

## 0.0.14

- Add a task-scoped **Changes panel** (command: "Open Task Changes panel", plus a
  Review affordance on dashboard rows): a Workspace Overview listing each task's local
  and unmerged change counts, and per-task **Local** / **Unmerged** tabs for reviewing,
  committing (multi-repo, shared message, per-file selection), pushing, merging, and
  opening a PR/MR.
- File diffs now open in a reusable popout window or main split (configurable via the
  "Diff window" setting) instead of a blocking modal.
- Add a configurable **editor-open** action (✎): open a changed file in the task's
  zellij pane or via an external editor command (`{file}`/`{line}` template).
- The diff view gained a toolbar with a **side-by-side** layout (now the default) alongside the
  unified view, plus a **line-wrap** toggle (vs. horizontal scroll). Both preferences persist.
- Known limitation: merging a multi-repo task currently integrates only its primary
  repo (the panel shows a caveat); committing is fully multi-repo.

## 0.0.1

- Initial proof-of-concept: task-centric control plane for native Claude Code
  agents. Markdown task notes express desired state; an in-plugin orchestrator
  reconciles actual state by launching `claude` in per-task git worktrees via
  zellij, tracks status through Claude Code hooks, and provides a workspace
  dashboard plus diff/merge review.
