# Follow-ups

<!-- next-id: 4 -->

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
