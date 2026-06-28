# CLAUDE.md

Router for agents. Keep this tight — depth lives in the linked docs.

## What this is

**OAWM (Agent Workspace Manager)** — a desktop-only **Obsidian plugin** that turns
markdown task notes into a desired-state control plane for Claude Code agents. An
in-plugin orchestrator launches `claude` in per-task git worktrees via zellij, tracks
status through Claude Code hooks, and provides a dashboard + per-task action bar + a
Changes panel for commit / diff / merge review. No daemon — it all runs in the plugin.

## Commands

| Task | Command |
|------|---------|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) |
| Test (all) | `npm test` (`vitest run`) |
| Test (one file) | `npx vitest run tests/<file>` |
| Build bundle | `npm run build` → `main.js` |
| Dev watch build | `npm run dev` |
| Cut a release | `just release <version>` (no leading `v`) |

The gate for "done" on code changes: `npm run typecheck` clean + `npm test` green +
`npm run build` emits `main.js`.

## Where things live

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — mental model, the two core flows (reconcile +
  status ingest), full module map. Read this first for any non-trivial change.
- **[docs/gotchas.md](docs/gotchas.md)** — non-obvious decisions / funky logic. Read
  before "simplifying" anything that looks odd.
- **[docs/index.md](docs/index.md)** — index of all topic docs.
- **[docs/MANUAL-TEST.md](docs/MANUAL-TEST.md)** — manual checks for the Obsidian-view
  surfaces (no automated DOM tests).
- **[docs/superpowers/plans/](docs/superpowers/plans/)** + **[specs/](docs/superpowers/specs/)** — per-effort plans/specs.
- **[FOLLOWUPS.md](FOLLOWUPS.md)** — in-scope tangents to clear before the next feature.
- **[ROADMAP.md](ROADMAP.md)** — larger planned efforts. **[CHANGELOG.md](CHANGELOG.md)** — shipped releases.
- **[idea.md](idea.md)** — aspirational product vision (much not yet built; don't treat as current state).
- **[docs/handoffs/](docs/handoffs/)** — ephemeral session handoffs (`creating-handoffs`).
- Source layout: `src/domain` (pure model) → `src/core` (logic + `ports.ts` interfaces)
  → `src/backends` (git/zellij/claude impls) → `src/obsidian` (views) → `src/main.ts`
  (composition root). Tests + fakes in `tests/`.
- **Canonical contracts (open these for exact signatures — don't grep):**
  `src/core/ports.ts` (~53 lines) is the authoritative list of every backend method
  (`GitBackend`, `MuxBackend`, `VaultGateway`, `AgentBackend`, `Notifier`);
  `src/domain/types.ts` (~56 lines) is the authoritative `TaskNote`/`WorkspaceNote`/
  `AgentNote` shape + helper signatures; `tests/fakes.ts` shows the fake/seed API
  (`FakeGit`/`FakeVault`/`FakeNotifier`); `src/backends/exec.ts` is the `run(...)`
  signature. These files are small and self-documenting — the docs deliberately do not
  duplicate their type definitions.

## Conventions

- **Ports/adapters:** new side-effecting capability → add a method to the interface in
  `src/core/ports.ts`, implement in the matching `src/backends/*` adapter, and extend the
  fake in `tests/fakes.ts` so it still satisfies the interface.
- **Layering:** keep decision logic pure in `src/core`/`src/domain` and unit-test it;
  keep `ItemView` DOM thin (it has no node tests). `GitBackend` methods return result
  objects, never throw to the UI; user-facing messages go through `Notifier`.
- **Git:** raw `git` only (no `gh`/`glab`); base branch is per-task via
  `WorkspaceNote.baseBranch` — never assume `main`. Worktrees live **outside** the vault
  — never open them via the Obsidian Vault API / `TFile`.
- **TDD:** write the failing test first for `src/core`/`src/domain`/`src/backends` work.

## Sync agreement (keep docs true — part of "done")

- Add/rename a module or change a core flow → update the **ARCHITECTURE.md** module map / flow.
- Add non-obvious logic, a workaround, or a magic value → add it to **docs/gotchas.md** (or a precise inline comment if purely local).
- Hit a small in-scope tangent → add a numbered `## N.` section to **FOLLOWUPS.md** (take N from its `next-id`, then bump it).
- Plan a new feature / larger effort → add a numbered `## N.` section to **ROADMAP.md**.
- Ship a user-facing change → add a bullet under `## Unreleased` in **CHANGELOG.md** (`just release` promotes it).
- Dated history is a *log*: append `## YYYY-MM-DD` entries to a `docs/<topic>-log.md`, never grow a CLAUDE.md/ARCHITECTURE.md section into a changelog.
