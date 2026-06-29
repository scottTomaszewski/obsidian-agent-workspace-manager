# Follow-ups

<!-- next-id: 9 -->

In-scope tangents found while working — important to fix, but they'd derail the task
at hand. Add a numbered `## N.` section below (take N from `next-id` above, then
increment it) instead of chasing them now, and **clear these before starting a new
feature.** New features and larger efforts go in ROADMAP.md, not here.

Numbers are permanent: never reused, never renumbered. Done items get pruned to
`docs/followups-archive/` keeping their original number as a `(was FOLLOWUPS #N)`
handle, so gaps in the live list are normal. **Referenced `#N` not in this file? It's
completed — `grep -rn 'was FOLLOWUPS #N' docs/followups-archive/`.**

<!-- Template — copy for each item; take N from next-id above, then bump next-id:
## N. Short title
**Status:** open
What needs doing and why. Code blocks, commands, and links are fine here.
Mark **Status:** done when resolved; pruned (never renumbered) on the next cleanup pass. -->

## 4. Windows ConPTY patch (deferred Task 6)

**Status:** open

The embedded terminal does not work on Windows because `windowsConoutConnection.js` (part
of the mainline node-pty package) spawns a Worker thread, which is unavailable in the
Electron renderer. The fix is to vendor a Worker-thread-free replacement, inline it into
`main.js` via an esbuild `.txt` text-loader, and write it to disk next to the installed
node-pty on win32 install.

Until this patch is implemented, Windows users must use the External-window host; the
embedded terminal is unavailable on Windows. Reference:
`docs/superpowers/plans/2026-06-29-terminal-binary-provisioning.md` Task 6.

## 5. Bake `checksums.json` into `main.js` at build time

**Status:** open

Currently `checksums.json` is fetched from the GitHub Release at install time alongside the
binary zip. Baking it into `main.js` at build time (i.e. building `main.js` in CI *after*
the binary artifacts exist and their checksums are known) would eliminate one network round
trip on install and allow checksum verification without a separate fetch.

Requires restructuring the release CI so `main.js` is built after the binary matrix jobs
complete and their checksums are collected.

## 6. Skip binary rebuild when pinned node-pty version is unchanged

**Status:** open

The CI matrix currently rebuilds and uploads platform binaries on every release, even when
the pinned node-pty version has not changed. Add a check: if the node-pty version in the
release tag matches the most recent binary release, skip the rebuild and re-point the
download URL to the existing binary release instead of producing new artifacts.

## 7. Prune stale `node_modules/@homebridge` after upgrade

**Status:** open

Users who had an earlier plugin version installed (which used
`@homebridge/node-pty-prebuilt-multiarch`) will have a leftover `node_modules/@homebridge`
directory after upgrading. Add a one-time cleanup step in `NodePtyProvisioner.install` (or
`onload`) that removes `<pluginDir>/node_modules/@homebridge` if it exists, so the stale
fork does not linger on disk.

## 1. Agent-process death isn't detected while the session stays alive

**Status:** open

**Problem:** Liveness self-healing marks a task `Failed` only when the *zellij
session* dies (`isAlive` returns false). But the launch pane runs
`bash -lc '<command>; exec bash'` — the trailing `exec bash` keeps the pane (and
therefore the session) alive after the agent process exits. So if `claude` itself
crashes or exits abnormally **without firing a Stop/Notification hook**, the
session still looks alive, no marker is written, and `agentState` stays at
whatever it last was (e.g. `Running`) indefinitely. The sweep can't tell
"agent still working" from "agent dead, shell idle."

**Why `exec bash` is there:** intentional — it keeps the terminal open so the
user can inspect output / scrollback after the agent finishes or errors. Removing
it would close the pane on agent exit and lose that.

**Possible approaches (not yet chosen):**
- Have the launcher write a "session ended" marker when the agent command exits,
  e.g. `<command>; oawm-hook ended --task <id> --status-dir <dir>; exec bash`.
  This gives a durable, hook-independent signal that the agent process exited,
  which the sweep/ingest can map to `Failed` (or a new `Ended`/`NeedsReview`
  state). Most robust and reuses the existing marker pipeline.
- Inspect the pane for a running `claude` process (e.g. via `zellij action`
  dump or matching the process tree under the session) during the sweep. More
  fragile and zellij-version-sensitive.
- Track the agent's exit code by wrapping the command and recording it to the
  status dir.

The first approach (an explicit "agent exited" marker emitted by the launch
script) is the cleanest fit with the existing durable-marker self-healing model.

## 2. The `✎` editor affordance always opens at line 1

**Status:** open

`buildEditorCommand` (`src/core/editorOpen.ts`) supports a `{line}` placeholder, but
`OawmPlugin.openEditor` (`src/main.ts`) never passes a `line`, so it always defaults
to `1`. The Changes panel knows which file a row is, but not which line. To make
`{line}` meaningful, the file-row/diff click would need to carry a line number
(e.g. from the diff hunk the user clicked) through to `openEditor`. Until then the
`{line}` template support is effectively dead.

## 3. `openDiffLeaf` double-renders when reusing an existing diff leaf

**Status:** open

In `src/obsidian/diffView.ts`, when an `oawm-diff` leaf already exists, `openDiffLeaf`
calls `leaf.setViewState(...)` (which triggers `onOpen()` → `render()` with the *old*
state) and then immediately `view.setDiff(state)` (a second `render()` with the new
state). The result is correct (the second render wins) but the first render is wasted
work. Harmless; tidy up if touching this file.

## 8. Re-add darwin-x64 (Intel Mac) release binary

**Status:** open

`.github/workflows/release-binaries.yml` temporarily drops the `macos-13 /
node-pty-darwin-x64.zip` matrix entry because GitHub's Intel-mac runners queue for a
long time and Intel Macs aren't a current priority. Consequence: on an Intel Mac the
runtime requests `node-pty-darwin-x64.zip`, which won't exist on the release, so the
embedded-terminal install fails gracefully to the prompt + External-window fallback.

To restore: re-add the matrix entry:
```yaml
          - os: macos-13
            asset: node-pty-darwin-x64.zip
```
