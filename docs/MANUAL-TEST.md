# OAWM Manual Integration Checklist

Prereqs: `git`, `zellij`, `claude` on PATH. One `CLAUDE_CONFIG_DIR` logged in (e.g. ~/.claude-accounts/vexa).
Install: copy `main.js`, `manifest.json`, `styles.css`, `oawm-hook.mjs` into `<vault>/.obsidian/plugins/oawm/`. Enable plugin.

1. Create `Agents/vexa.md` (type: agent, account.config_dir set), `Projects/Demo/Demo.md` (type: workspace,
   repositories pointing at a real local git repo, base_branch main), and a task note with an `oawm-task` code block.
2. Click **Start** (or set status: Running). Verify:
   - [ ] a worktree appears under `<repo>/.oawm-worktrees/<id>-<slug>/`
   - [ ] a zellij session `oawm-<id>` exists (`zellij list-sessions`)
   - [ ] `claude` is running in it under the right account
   - [ ] task frontmatter shows agent_state: Running, branch, worktree, session
3. In the claude session, trigger a prompt that asks you something → Notification hook fires.
   - [ ] `.oawm/status/<id>.json` written with event "waiting"
   - [ ] task badge flips to Waiting + Obsidian notice
4. Let claude finish a turn (Stop hook).
   - [ ] badge flips to NeedsReview
5. Click **View Diff** → modal shows colored diff of the branch.
6. Click **Complete & Merge** → branch merges into main, worktree removed, session killed.
7. Dirty-guard: start another task, leave uncommitted work in its worktree, Complete → confirm dialog appears;
   declining leaves the worktree intact.
8. Crash backstop: start a task, `zellij kill-session oawm-<id>` manually → within 15s badge flips to Failed.
   NOTE: because the session runs `claude; exec bash`, the 15s Failed backstop detects whole-session death (e.g. `zellij kill-session`), not the claude process exiting on its own (the pane persists by design so you can inspect it).
