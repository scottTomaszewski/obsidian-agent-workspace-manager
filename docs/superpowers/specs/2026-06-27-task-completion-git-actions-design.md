# Task Completion & Git Actions — Design

**Date:** 2026-06-27
**Status:** Approved design, ready for implementation planning
**Scope:** Replace the single "Complete & Merge" action with explicit, imperative git actions in the task item's action bar: **Merge**, **Merge & Push**, **Push**, **Open PR/MR**. Fix the current merge so it never disrupts the user's main checkout. Raw `git` only.

## Summary

The task item's action bar currently exposes one `complete` action, implemented by `orchestrator.completeAndMerge`, which runs `git checkout <base>` in the **main repo** and merges there — flipping the user's checkout and breaking on a dirty tree. This design replaces it with four explicit git actions surfaced as buttons in the task note, executed imperatively (not via desired-state reconciliation), using only raw `git` commands.

Committing remains out of scope: it is handled by the agent or by the forthcoming IntelliJ-style staged/unstaged changes view (a separate, larger design). These actions operate on **committed** work; uncommitted working-tree changes trigger a warning that lets the user proceed anyway or wait.

## Decisions (locked)

| Area | Decision |
|---|---|
| Actions | Four buttons in the task item: **Merge**, **Merge & Push**, **Push**, **Open PR/MR** |
| Action model | Imperative one-shot actions on click — NOT routed through desired-state reconciliation |
| Finishing actions | Merge and Merge & Push complete the task and tear down the worktree; Push and Open PR do not |
| Merge mechanics | Approach B: integrate base into the task branch **in the task worktree** (conflicts surface there), then fast-forward base |
| Remote ops | Raw `git` only — no `gh`/`glab` |
| Open PR/MR | GitLab: `git push -o merge_request.create -o merge_request.target=<base>`; GitHub: push + open constructed `compare` URL in the browser |
| Uncommitted work | Warn and allow proceed-anyway or wait; finishing actions force-discard only after explicit confirm |
| Committing | Out of scope (deferred to the changes view / the agent) |

## Action Bar & Action Model

The single `complete` action is replaced by four git actions, shown when the task is active (`agent_state` ∈ `Running`/`Waiting`/`NeedsReview`) and has a `branch`:

```
[ Open Terminal ] [ View Diff ] [ Merge ] [ Merge & Push ] [ Push ] [ Open PR ] [ Cancel ]
```

| Button | Behavior | Finishes task? |
|---|---|---|
| **Merge** | Integrate base into the task branch, fast-forward base, remove worktree | Yes → `status: Completed` |
| **Merge & Push** | Merge (as above) + `git push origin <base>`, remove worktree | Yes → `status: Completed` |
| **Push** | `git push -u origin <task-branch>` | No |
| **Open PR** | Push branch + create MR (GitLab) or open compare URL (GitHub) | No |

**Imperative, not desired-state.** Push, Open PR, and the Merge-vs-Merge&Push distinction do not map onto a single `status` value, so these buttons execute directly when clicked rather than via reconciliation. The desired-state model continues to own the lifecycle (`Pending` → `Running` → `Completed`/`Cancelled`). To preserve the existing path, editing `status: Completed` in frontmatter and clicking **Merge** both invoke the same **Merge** action (local, no push).

## Merge Mechanics (Approach B)

On **Merge** / **Merge & Push**, in order:

1. **Uncommitted check** (see "Uncommitted Work") — may warn/abort.
2. **Integrate base into the task branch**, run in the task worktree: `git merge --no-ff <base>`.
   - **Clean** → the branch now contains base; continue.
   - **Conflicts** → leave them in place in the task worktree (do not abort), set `agent_state: NeedsReview`, keep `status: Running`, keep the worktree, and notice: *"Merge conflict — resolve in the task terminal (Open Terminal), then click Merge again."* Stop.
3. **Advance base to the branch** (now a guaranteed fast-forward):
   - Find base's checkout via `git worktree list --porcelain`. If base is checked out → `git -C <baseWorktree> merge --ff-only <task-branch>`. If that worktree is dirty and the ff is blocked → stop with a clear notice (never force).
   - If base is not checked out in any worktree → `git branch -f <base> <task-branch>`.
4. **(Merge & Push only)** `git push origin <base>`.
5. **Teardown** → kill session, `git worktree remove` (with `--force` only when the uncommitted-discard path was confirmed), set `status: Completed`, `agent_state: Idle`, clear `branch`/`worktree`/`session`.

**Conflict resume.** Conflicts are resolved **and committed** by the user/agent in the task worktree (resolving alone leaves git in an in-progress merge with `MERGE_HEAD` present). The next **Merge** click re-runs `git merge --no-ff <base>`, which is now clean (or "Already up to date"), then proceeds. No separate resume state machine. If a Merge click finds a merge still in progress (`MERGE_HEAD` exists — resolved but not committed, or unresolved), `mergeBaseIntoBranch` reports it distinctly and the coordinator notices: *"Finish resolving and commit the in-progress merge in the task terminal, then retry."* — rather than surfacing an opaque git error.

**Why the main checkout is never disrupted.** Step 2 runs in the task worktree; step 3 only fast-forwards base (or moves an unattached ref), which cannot produce a conflict or clobber uncommitted work in the user's main checkout — a blocked ff is reported, not forced.

## Uncommitted Work

Before any action, check the task worktree with `git status --porcelain`. The warning depends on whether the action discards uncommitted changes:

- **Non-finishing (Push, Open PR)** — worktree stays, nothing lost:
  > "Worktree has uncommitted changes — only committed work will be pushed; uncommitted changes stay in the worktree. Continue?"

  Confirm → proceed (pushes committed commits). Cancel → abort.
- **Finishing (Merge, Merge & Push)** — worktree is removed, so uncommitted work would be lost:
  > "Worktree has uncommitted changes that will be discarded when the worktree is removed after merge. Merge committed work and discard the rest?"

  Confirm → proceed; the final `git worktree remove` uses `--force`. Cancel → abort.

If the worktree is clean, no prompt — proceed directly.

The warning is specifically about uncommitted working-tree changes (`git status --porcelain`), distinct from committed-but-unmerged commits (which are exactly what Merge integrates, and never warned about).

## Push & Open PR/MR (raw git, host-aware)

**Push** (non-finishing): `git push -u origin <task-branch>`. Success → notice "Pushed `<branch>`."; failure → notice with the git error. No state change.

**Open PR/MR** (non-finishing):
1. Read the remote: `git remote get-url origin` → parse host + `<owner>/<repo>` (handle `git@host:owner/repo.git` and `https://host/owner/repo.git`).
2. Branch by host:
   - **GitLab** → `git push -u -o merge_request.create -o merge_request.target=<base> origin <task-branch>`. The MR is created server-side; surface any MR URL git prints as a notice.
   - **GitHub** → `git push -u origin <task-branch>`, then open `https://github.com/<owner>/<repo>/compare/<base>...<task-branch>?expand=1` in the browser.
   - **Unknown host** → push only, notice the branch name (no URL).
3. Opening the URL is done Obsidian-side via `electron`'s `shell.openExternal`; the core logic returns `{ url? }` and `main.ts` opens it.

**Host detection** is a pure function (`parseRemote(url) → { host: "github" | "gitlab" | "other", owner, repo }`), unit-testable without git.

**Errors.** Any git failure in Push/Open PR surfaces stderr in a notice and leaves the task untouched (non-finishing — nothing to roll back).

## Components & File Structure

- **`GitBackend` — new raw-git primitives:**
  - `mergeBaseIntoBranch(worktreePath, base) → { ok, conflicts, message }`
  - `worktreeDirty(worktreePath) → boolean`
  - `fastForwardBase(repoPath, base, branch) → { ok, reason? }` — ff in base's worktree (found via `git worktree list --porcelain`), or `git branch -f` if base is unattached
  - `pushBranch(repoPath, branch, opts?: { mrTarget?: string }) → { ok, message }` — adds GitLab `-o merge_request.*` options when `mrTarget` is set
  - `pushBase(repoPath, base) → { ok, message }`
  - `getRemoteUrl(repoPath) → string`
  - Keep `removeWorktree`; remove the old `merge` and `hasUncommittedOrUnmerged` once unused.
- **`src/core/remote.ts` (pure):** `parseRemote(url)` and `compareUrl(remote, base, branch)`. Host detection and the GitHub compare URL. Fully unit-tested.
- **`src/core/completion.ts` — `CompletionCoordinator`:** constructed with `{ vault, git, mux, notifier }`. Methods: `merge(task, { push })`, `pushBranch(task)`, `openPr(task) → { url?: string }`. Owns the uncommitted-warning, conflict handling, fast-forward, teardown, and state writes. Keeps `orchestrator.ts` from growing.
- **`orchestrator.completeAndMerge`** → replaced by delegation to `coordinator.merge(task, { push: false })`, so the `status: Completed` desired-state path and the **Merge** button share one implementation.
- **`taskCodeBlock.ts`:** `ActionId` gains `"merge" | "mergePush" | "push" | "openPr"` and drops `"complete"`; `availableActions` returns these for active states that have a branch.
- **`main.ts`:** `handleAction` routes the four actions to the `CompletionCoordinator`; for `openPr`, opens the returned URL via `electron` `shell.openExternal`.

### State transitions

| Action | Result |
|---|---|
| Merge / Merge & Push (clean) | `status: Completed`, `agent_state: Idle`, clear branch/worktree/session |
| Merge (conflict) | `agent_state: NeedsReview`, stays `Running`, worktree kept |
| Push / Open PR | no state change (notice only; Open PR may open a browser tab) |

## Testing

- **Pure logic (unit, no git):**
  - `parseRemote` / `compareUrl` against `git@github.com:o/r.git`, `https://github.com/o/r.git`, GitLab equivalents, and an unknown host.
  - `availableActions` returns the four buttons for active states with a branch.
  - `CompletionCoordinator` against fakes (FakeGit/FakeMux/FakeVault/FakeNotifier), driving every branch: clean merge → Completed + teardown; conflict → NeedsReview + worktree kept; uncommitted + confirm → force-remove; uncommitted + decline → abort; merge & push → `pushBase` called; push → `pushBranch` called, no state change; openPr GitHub → returns compare URL; openPr GitLab → `pushBranch` called with `mrTarget`. Assert exact backend calls and frontmatter writes.
- **GitBackend contract (real temp repos):**
  - `mergeBaseIntoBranch`: clean integration; a crafted real conflict → `conflicts: true` and the worktree left conflicted (not aborted).
  - `fastForwardBase`: base checked out → ff advances it; base not checked out → `branch -f` moves the ref; dirty base worktree blocks ff → `{ ok: false }`.
  - `worktreeDirty`: true with an uncommitted change, false when clean.
  - `pushBranch`/`pushBase`: against a local bare remote (`git init --bare` + `git remote add`), assert the ref lands; assert GitLab `-o` options are present in the argv (a local bare remote ignores them harmlessly).
- **Manual (irreducible):** real GitHub compare URL opening in a browser; a real GitLab MR push — documented in `docs/MANUAL-TEST.md`.

## Out of Scope

- Committing changes (agent- or changes-view-driven; separate design).
- The IntelliJ-style staged/unstaged changes tool window (separate, larger design).
- `gh`/`glab` CLIs and platform APIs.
- Multi-repo completion (a task resolves to its first repo's worktree, consistent with the rest of the POC).
