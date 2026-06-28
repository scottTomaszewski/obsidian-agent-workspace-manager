# Embedded Terminal — Design

**Date:** 2026-06-28
**Status:** Approved design, ready for implementation planning
**Scope:** Run agent sessions inside an in-Obsidian terminal (xterm.js + node-pty) as
an alternative to spawning an external OS terminal window (`gnome-terminal` etc.). One
terminal **leaf per task**. zellij stays the persistence spine — the embedded terminal
only hosts the existing launch script / `zellij attach`. Includes a **settings cleanup**
so the new option doesn't add to an already-confusing flat settings list. The tmux
`MuxBackend` is explicitly **deferred** to a follow-up spec.

## Summary

Today OAWM launches agents by spawning an external terminal emulator window
(`SpawnTerminalLauncher` → `gnome-terminal --`) that runs a bash launch script which
starts a detached **zellij** session. This requires a GUI terminal emulator on the host
and scatters agent windows outside Obsidian.

This effort adds an **embedded terminal**: an Obsidian `ItemView` (one leaf per task)
hosting an [xterm.js](https://xtermjs.org) terminal backed by a real PTY
([node-pty](https://github.com/microsoft/node-pty)). The key enabling insight is that
`TerminalLauncher` (`src/backends/terminal.ts`) already separates *what command runs*
from *where the window lives*. `ZellijBackend` builds a launch script and calls
`launcher.open(["bash", scriptPath], {cwd, env})`. So the embedded terminal is
fundamentally **one new `TerminalLauncher` implementation** — all the zellij
layout / launch-script / keep-open-on-error logic is reused verbatim, and `openPane` /
`isAlive` / `kill` (headless zellij CLI calls) are untouched.

zellij continues to run as a **detached server**, so agents survive Obsidian
restarts/crashes; the embedded view is just a viewport that attaches.

## Decisions (locked)

| Area | Decision |
|---|---|
| Platform scope | All desktop: Linux, macOS, Windows |
| Multiplexer role | zellij **stays underneath** (persistence). Embedded view hosts the launch script / `zellij attach`. No "PTY owns the agent directly / no-persistence" mode is built |
| tmux | **Deferred** — tracked as a follow-up `MuxBackend` adapter; not in this spec |
| Terminal UX | **One leaf per task** (`ItemView`); use Obsidian's native tab/tile system for arrangement |
| PTY mechanism | **node-pty with bundled prebuilt binaries** (`@homebridge/node-pty-prebuilt-multiarch` or equiv.). Not a Rust sidecar, not runtime-build |
| Terminal host setting | New **Terminal host: Embedded \| External window**, default **Embedded**; external path unchanged |
| Settings cleanup | Group settings under headings; conditionally render dependent fields; rename "Zellij path" → "Multiplexer path" |
| Restart restore | Auto-restoring leaves on plugin load is **out of scope** (YAGNI); "Open Terminal" re-attaches |

## Why these choices

- **One new `TerminalLauncher`, not a rewrite.** The launcher seam already isolates
  window-spawning from command-building. Reusing the zellij launch script verbatim keeps
  the blast radius tiny and means the embedded path inherits all the existing
  cd/env/keep-open-on-error behavior for free.
- **zellij stays the spine.** OAWM's value of "agents survive that you can detach/reattach"
  comes from zellij's detached server. If OAWM's own process owned the PTY, the agent would
  die when Obsidian quit. Keeping zellij underneath preserves persistence and means the
  embedded view is a pure viewport.
- **node-pty over a Rust sidecar.** "Rust is faster" does not hold for a PTY — a PTY is a
  thin wrapper over OS syscalls (`forkpty`/ConPTY); the throughput bottleneck is xterm.js
  DOM rendering, identical regardless of PTY lib, and node-pty's hot path is already native
  C++. A Rust sidecar's only real advantage is ABI-immunity, paid for with a second
  toolchain, 5-target cross-compile, macOS notarization / Windows signing, and an IPC
  protocol — disproportionate for a solo-maintained plugin whose audience already installs
  `claude`/`git`/`zellij`. node-pty is the proven path (Lean Terminal, polyipseity's
  Terminal both use it). The `PtyBackend` port leaves the sidecar as a clean future swap.
- **Settings cleanup is part of the work, not after it.** Adding "Terminal host" on top of
  the current flat 7-item list would worsen two already-implicit couplings
  (`terminalCommand` only matters for external terminals; `editorCommand` only matters for
  the external editor strategy). Grouping + conditional rendering makes the visible options
  the ones that actually apply to the user's config.

## Architecture & Components

### The seam (one interface tweak)

`ZellijBackend` currently **constructs its own** `SpawnTerminalLauncher` internally. Change
it to take an injected `TerminalLauncher`, chosen at the composition root (`main.ts`) by the
"Terminal host" setting. `ZellijBackend` keeps depending only on the `TerminalLauncher`
*interface*, so the dependency direction is preserved (the concrete Obsidian-layer impl is
injected at the root).

`TerminalLauncher.open` gains optional fields on its opts object:

```
open(inner: string[], opts?: { cwd?; env?; key?: string; title?: string }): Promise<void>
```

- `key` — stable identity for the window (the zellij `session`); the embedded launcher uses
  it to reveal an existing leaf instead of opening a duplicate.
- `title` — human label for the leaf/tab (the task name).
- `SpawnTerminalLauncher` **ignores** `key`/`title` (behavior unchanged).
- `ZellijBackend.create`/`focus` pass `key = session` and `title = task name`.

### New: `PtyBackend` port + `NodePtyHost` adapter

A thin port isolating node-pty (per the ports/adapters convention — interface in
`src/core/ports.ts`, adapter in `src/backends/`, fake in `tests/fakes.ts`):

```
interface PtyHandle {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
interface PtyBackend {
  spawn(argv: string[], opts: { cwd?: string; env?: Record<string, string> }): PtyHandle;
}
```

`NodePtyHost` wraps `node-pty.spawn(argv[0], argv.slice(1), {cwd, env, name:'xterm-color', cols, rows})`.
A `FakePty` in `tests/fakes.ts` records spawns and lets tests drive `onData`/`onExit`,
so launcher-decision logic is unit-testable without the native module.

### New: `EmbeddedTerminalLauncher` (`src/obsidian/`)

Implements `TerminalLauncher`. Lives in the Obsidian layer because it touches
`app.workspace` / `WorkspaceLeaf`. On `open(inner, {cwd, env, key, title})`:

1. If a `TerminalView` leaf already exists for `key`, reveal/activate it and return
   (idempotent "Open Terminal" / reconcile).
2. Otherwise create a new leaf of the OAWM terminal view type, hand it `{ argv: inner,
   cwd, env, title }`, and reveal it. The view starts the PTY via `PtyBackend`.

### New: `TerminalView extends ItemView` (`src/obsidian/`)

Hosts one xterm.js `Terminal` + `FitAddon`:

- Pipes `pty.onData → term.write` and `term.onData → pty.write`.
- Fits on open and on Obsidian layout/resize events; calls `pty.resize(cols, rows)`.
- On `pty.onExit`, writes the same `[oawm] session ended (exit N). …` message the bash
  scripts already print and leaves the pane open so errors stay readable.
- Sets the tab title from `title`; tracks `key` so the launcher can find it.
- On view close: kill the PTY (the detached zellij session survives regardless).

## Data flow

**Create (reconcile launches an agent):**
`Orchestrator → ClaudeBackend.launch → ZellijBackend.create` (writes layout + launch
script, unchanged) `→ launcher.open(["bash", scriptPath], {cwd, env, key:session,
title})`. Embedded launcher opens a leaf; `TerminalView` spawns a PTY running the script;
the script `cd`s, exports env, and starts the detached zellij session — exactly as today,
just inside Obsidian.

**Focus ("Open Terminal" action):** `ZellijBackend.focus` → `launcher.open(["bash","-lc",
"zellij attach …; …"], {key:session, title})`. Embedded launcher reveals the live leaf if
present; otherwise opens a new leaf that runs `zellij attach`.

**Open editor pane / status / kill:** unchanged — `openPane`, `isAlive`, `kill` are
headless `zellij` CLI calls independent of the window mechanism.

## Lifecycle & persistence

- zellij runs as a **detached server**; the embedded leaf is a viewport.
- **Obsidian restart:** leaves are gone but zellij sessions persist → "Open Terminal"
  re-attaches via a fresh leaf running `zellij attach`. Auto-restoring leaves on load is
  out of scope.
- Closing a terminal leaf kills only that PTY/attachment, not the agent session.

## Settings cleanup

Current state: 7 settings in one flat list with two hidden "only-sometimes-relevant"
couplings. `diffLayout`/`diffWrap` exist in the settings object but have **no tab UI**
(toggled from the diff view) and stay that way.

Reorganize `OawmSettingTab.display()` into **headed groups** with **conditional rendering**
(re-call `display()` from the controlling dropdown's `onChange` to show/hide dependents):

```
Agent terminal
  • Terminal host        [ Embedded ▾ | External window ]     ← new
  • Terminal command     (rendered only when host = External window)
  • Multiplexer path     [zellij]   ← renamed from "Zellij path"

Editor
  • Open strategy        [ Terminal pane (zellij) ▾ | External command ]
  • Editor command       (rendered only when strategy = External command)

Diff
  • Diff window          [ Popout ▾ | Split | New tab ]
```

New setting field: `terminalHost: "embedded" | "external"` (default `"embedded"`). The
`zellijPath` field/value is unchanged in storage; only its display label changes to
"Multiplexer path". `main.ts` selects `EmbeddedTerminalLauncher` vs `SpawnTerminalLauncher`
from `terminalHost` and injects it into `ZellijBackend`.

## Packaging / build (the novel/risky part)

- Add `@xterm/xterm` + `@xterm/addon-fit` — pure JS, **bundled** into `main.js`; xterm CSS
  folded into `styles.css`.
- node-pty is **externalized** in esbuild; its prebuilt binary ships in the release. The
  release artifact becomes *main.js + manifest.json + styles.css + the node-pty module with
  the `.node` for each platform*. `just release` and the GitHub release assets change
  accordingly.
- Use a prebuilt-multiarch distribution (e.g. `@homebridge/node-pty-prebuilt-multiarch`)
  that carries prebuilds across Electron ABIs; **verify it loads against Obsidian's current
  Electron** as an explicit plan step.
- On native-module load failure, show a clear `Notice` ("couldn't load the embedded
  terminal — update OAWM, or switch Terminal host to External window") rather than failing
  silently. (Embedded is the default, so this is the visible failure mode if a prebuild is
  missing.)

## Error handling

- **PTY spawn fails** (e.g. `bash` missing): `TerminalView` shows the error in the pane and
  keeps it open; surface a `Notice`.
- **node-pty load fails:** load-time `Notice` with the External-window fallback hint.
- **Leaf for a dead session:** `focus` re-runs `zellij attach`, which prints zellij's own
  "no such session" and the existing keep-open message; reconcile/`isAlive` handle cleanup.

## Testing

- **Unit (TDD):** `EmbeddedTerminalLauncher` reveal-vs-create decision driven by a
  `FakePty` + a fake leaf registry; `buildTerminalArgv` already covered; any pure helper
  extracted from the view.
- **DOM (no node tests, per conventions):** `TerminalView` xterm wiring and the regrouped
  `OawmSettingTab` — add steps to `docs/MANUAL-TEST.md` (launch embedded, attach/detach,
  resize, exit-keeps-open, settings groups show/hide correctly, External-window fallback).

## Docs & follow-ups

- **ARCHITECTURE.md:** add `EmbeddedTerminalLauncher`, `TerminalView`, `PtyBackend`/
  `NodePtyHost` to the module map; note the injected-launcher seam.
- **docs/gotchas.md:** node-pty ABI/packaging; why zellij stays underneath; embedded leaf
  is a viewport (closing it ≠ killing the agent).
- **docs/MANUAL-TEST.md:** embedded terminal + settings-group checks.
- **ROADMAP.md / FOLLOWUPS.md:** numbered entry for the deferred **tmux `MuxBackend`**
  adapter.

## Out of scope

- tmux (or any second multiplexer) backend.
- A no-multiplexer / PTY-owns-the-agent mode (loses persistence).
- Auto-restoring terminal leaves on plugin load.
- An internal tab bar / single-consolidated-terminal view (we use one leaf per task).
- Surfacing `diffLayout`/`diffWrap` in the settings tab.
