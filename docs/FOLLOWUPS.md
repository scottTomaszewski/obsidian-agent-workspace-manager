# OAWM Follow-ups

Known limitations and deferred work discovered during use. Each item notes the
cause and possible approaches so it can be picked up later.

## Agent-process death isn't detected while the session stays alive

**Status:** open

**Problem:** Liveness self-healing marks a task `Failed` only when the *zellij
session* dies (`isAlive` returns false). But the launch pane runs
`bash -lc '<command>; exec bash'` — the trailing `exec bash` keeps the pane (and
therefore the session) alive after the agent process exits. So if `claude` itself
crashes or exits abnormally **without firing a Stop/Notification hook**, the
session still looks alive, no marker is written, and `agent_state` stays at
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
