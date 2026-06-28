# OAWM Manual Integration Checklist

Prereqs: `git`, `zellij`, `claude` on PATH. One `CLAUDE_CONFIG_DIR` logged in (e.g. ~/.claude-accounts/vexa).
Install: copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/oawm/`. Enable plugin. (The plugin writes `oawm-hook.mjs` into that folder itself on load.)

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
6. Completion actions (task must have a branch):
   - [ ] **Merge**: branch fast-forwards into base branch, worktree removed, session killed. Badge → Idle.
   - [ ] **Merge & Push**: same as Merge, then also pushes base branch to remote.
   - [ ] **Push**: pushes task branch to remote without merging (session stays live).
   - [ ] **Open PR/MR**: pushes task branch; on GitHub opens the compare URL in the browser; on GitLab triggers MR via push options.
7. Dirty-guard: start another task, leave uncommitted work in its worktree, click Merge → confirm dialog appears;
   declining leaves the worktree intact.
8. Crash backstop: start a task, `zellij kill-session oawm-<id>` manually → within 15s badge flips to Failed.
   NOTE: because the session runs `claude; exec bash`, the 15s Failed backstop detects whole-session death (e.g. `zellij kill-session`), not the claude process exiting on its own (the pane persists by design so you can inspect it).

## Task Changes Panel

Requires at least one task with a worktree and branch.

9. Open the panel (command palette → "Open Task Changes panel"):
   - [ ] Panel opens in the right sidebar showing "Workspace Changes".
   - [ ] Tasks with active worktrees are listed under their state heading with `● N local  ↑ N unmerged` counts.
   - [ ] Clicking a task row drills into the task view (header shows task title, branch → base).
   - [ ] ▲ link returns to the Workspace Overview.
   - [ ] With no active worktree tasks the panel shows "No active tasks with worktrees."
10. Local tab (default):
   - [ ] Files are listed per repo under `▸ repo-name` headings with kind badges (M/A/D/R/?).
   - [ ] Checking files across two repos updates the checkboxes; typing a message in the textarea enables the "Commit" and "Commit & Push" buttons.
   - [ ] "Commit" commits checked files in each repo with the typed message; panel refreshes and list is empty if all changes were staged.
   - [ ] "Commit & Push" commits and pushes; grouped notice appears per repo.
   - [ ] ⟳ button refreshes the file list.
11. File diff and editor:
   - [ ] Clicking a file link opens its diff (popout window by default; flip Settings → "Diff window" to "Main split" to verify that path too).
   - [ ] ✎ link with strategy "Terminal pane (zellij)" opens the file in a new zellij pane in the task's session at line 1.
   - [ ] ✎ link with strategy "External command" (e.g. `code -g {file}:{line}`) spawns the GUI editor detached.
12. Unmerged tab:
   - [ ] Switching to the Unmerged tab shows committed files that differ from the base branch.
   - [ ] "Merge" fast-forwards the base branch and navigates back to the Overview on completion.
   - [ ] "Merge & Push" does the same and also pushes the base branch.
   - [ ] "Open PR/MR" pushes the task branch and (on GitHub) opens the compare URL in the browser.
