# Changelog

All notable changes to this project are documented in this file. The
"Unreleased" section is promoted to a version heading by `just release`, and its
body becomes that release's GitHub notes.

## 0.0.1

- Initial proof-of-concept: task-centric control plane for native Claude Code
  agents. Markdown task notes express desired state; an in-plugin orchestrator
  reconciles actual state by launching `claude` in per-task git worktrees via
  zellij, tracks status through Claude Code hooks, and provides a workspace
  dashboard plus diff/merge review.
