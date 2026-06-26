# Task Completion & Git Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single "Complete & Merge" action with four imperative git actions in the task action bar — Merge, Merge & Push, Push, Open PR/MR — using raw `git`, without disrupting the user's main checkout.

**Architecture:** A pure `remote.ts` (host detection + compare URL) and a `CompletionCoordinator` (in `src/core/`, Obsidian-independent, driven by the existing ports) own the action logic; new raw-git primitives live on `GitBackend`/`RealGitBackend`. The orchestrator's `completeAndMerge` delegates to the coordinator so the `status: Completed` path and the Merge button share one implementation. The action bar exposes the four buttons; `main.ts` routes them to the coordinator and opens PR URLs via Electron.

**Tech Stack:** TypeScript, Vitest, raw `git` via the existing `run()` helper, Obsidian plugin API.

## Global Constraints

- Raw `git` only — no `gh`/`glab` or platform APIs.
- Actions are imperative one-shot operations executed on click, NOT routed through desired-state reconciliation. The lifecycle states stay `status ∈ {Pending,Running,Completed,Cancelled}`, `agent_state ∈ {'',Idle,Running,Waiting,NeedsReview,Failed}`.
- Merge mechanics = Approach B: `git merge --no-ff <base>` **in the task worktree** (conflicts surface there), then fast-forward base. Never `git checkout <base>` in the main repo; never force a fast-forward.
- Finishing actions (Merge, Merge & Push) tear down the worktree and force-discard uncommitted work **only after an explicit confirm**. Non-finishing (Push, Open PR) never discard.
- Open PR/MR: GitLab → `git push -u -o merge_request.create -o merge_request.target=<base> origin <branch>`; GitHub → push + open `https://github.com/<owner>/<repo>/compare/<base>...<branch>?expand=1`; unknown host → push only.
- Branch naming (existing): branch `oawm/<id-lower>-<slug>`, worktree dir `<id-lower>-<slug>` (from `branchName`/`worktreeDirName` in `src/domain/types.ts`).
- Spec of record: `docs/superpowers/specs/2026-06-27-task-completion-git-actions-design.md`.
- Use the existing `run(cmd, args, { cwd })` helper from `src/backends/exec.ts` for all git calls (resolves with `{ code, stdout, stderr }`, never throws).

---

### Task 1: Pure remote parsing (`remote.ts`)

**Files:**
- Create: `src/core/remote.ts`
- Test: `tests/remote.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Remote { host: "github" | "gitlab" | "other"; owner: string; repo: string }`
  - `parseRemote(url: string): Remote`
  - `compareUrl(remote: Remote, base: string, branch: string): string` (GitHub compare URL)

- [ ] **Step 1: Write the failing test**

`tests/remote.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseRemote, compareUrl } from "../src/core/remote";

describe("parseRemote", () => {
  it("parses GitHub ssh and https remotes", () => {
    expect(parseRemote("git@github.com:acme/widget.git")).toEqual({ host: "github", owner: "acme", repo: "widget" });
    expect(parseRemote("https://github.com/acme/widget.git")).toEqual({ host: "github", owner: "acme", repo: "widget" });
    expect(parseRemote("https://github.com/acme/widget")).toEqual({ host: "github", owner: "acme", repo: "widget" });
  });
  it("parses GitLab remotes, including subgroups", () => {
    expect(parseRemote("git@gitlab.com:grp/sub/proj.git")).toEqual({ host: "gitlab", owner: "grp/sub", repo: "proj" });
    expect(parseRemote("https://gitlab.example.com/grp/proj.git")).toEqual({ host: "gitlab", owner: "grp", repo: "proj" });
  });
  it("returns other for unknown hosts or unparseable urls", () => {
    expect(parseRemote("git@bitbucket.org:acme/widget.git").host).toBe("other");
    expect(parseRemote("not a url")).toEqual({ host: "other", owner: "", repo: "" });
  });
});

describe("compareUrl", () => {
  it("builds a GitHub compare URL", () => {
    expect(compareUrl({ host: "github", owner: "acme", repo: "widget" }, "main", "oawm/t-1-x"))
      .toBe("https://github.com/acme/widget/compare/main...oawm/t-1-x?expand=1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/remote.test.ts`
Expected: FAIL — cannot find `../src/core/remote`.

- [ ] **Step 3: Implement**

`src/core/remote.ts`:
```ts
export interface Remote {
  host: "github" | "gitlab" | "other";
  owner: string;
  repo: string;
}

export function parseRemote(url: string): Remote {
  const s = url.trim().replace(/\.git$/, "");
  let hostName = "";
  let path = "";
  const ssh = s.match(/^git@([^:]+):(.+)$/);
  const https = s.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (ssh) { hostName = ssh[1]; path = ssh[2]; }
  else if (https) { hostName = https[1]; path = https[2]; }
  else { return { host: "other", owner: "", repo: "" }; }

  const parts = path.split("/").filter((p) => p.length > 0);
  const repo = parts.pop() ?? "";
  const owner = parts.join("/");
  const host: Remote["host"] = /(^|\.)github\.com$/i.test(hostName)
    ? "github"
    : /gitlab/i.test(hostName)
      ? "gitlab"
      : "other";
  return { host, owner, repo };
}

export function compareUrl(remote: Remote, base: string, branch: string): string {
  return `https://github.com/${remote.owner}/${remote.repo}/compare/${base}...${branch}?expand=1`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/remote.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/remote.ts tests/remote.test.ts
git commit -m "feat: pure remote parsing (host detection + GitHub compare URL)"
```

---

### Task 2: GitBackend interface + FakeGit primitives

**Files:**
- Modify: `src/core/ports.ts` (add methods to `GitBackend`)
- Modify: `tests/fakes.ts` (extend `FakeGit`)
- Test: `tests/fakes.test.ts` (add a FakeGit assertion)

**Interfaces:**
- Consumes: nothing new.
- Produces — new `GitBackend` methods (implemented for real in Task 4, faked here):
  - `mergeBaseIntoBranch(worktreePath: string, base: string): Promise<{ ok: boolean; conflicts: boolean; inProgress: boolean; message: string }>`
  - `worktreeDirty(worktreePath: string): Promise<boolean>`
  - `fastForwardBase(repoPath: string, base: string, branch: string): Promise<{ ok: boolean; reason?: string }>`
  - `pushBranch(repoPath: string, branch: string, opts?: { mrTarget?: string }): Promise<{ ok: boolean; message: string }>`
  - `pushBase(repoPath: string, base: string): Promise<{ ok: boolean; message: string }>`
  - `getRemoteUrl(repoPath: string): Promise<string>`
  - `FakeGit` recording fields used by Task 3: `integratedBase: string[]`, `fastForwarded: {base,branch}[]`, `pushedBranches: {branch, mrTarget?}[]`, `pushedBases: string[]`, `removeCalls: {dir, force}[]`; config flags `conflicts`, `inProgress`, `ffOk`, `pushBranchOk`, `pushBaseOk`, `remoteUrl`.

- [ ] **Step 1: Write the failing test**

Append to `tests/fakes.test.ts` (inside the existing `describe("fakes", ...)` block):
```ts
  it("git records completion primitive calls", async () => {
    const { FakeGit } = await import("./fakes");
    const g = new FakeGit();
    g.remoteUrl = "git@github.com:o/r.git";
    expect(await g.getRemoteUrl("/repo")).toBe("git@github.com:o/r.git");
    await g.mergeBaseIntoBranch("/wt", "main");
    expect(g.integratedBase).toEqual(["main"]);
    await g.fastForwardBase("/repo", "main", "oawm/t-1");
    expect(g.fastForwarded).toEqual([{ base: "main", branch: "oawm/t-1" }]);
    await g.pushBranch("/repo", "oawm/t-1", { mrTarget: "main" });
    expect(g.pushedBranches).toEqual([{ branch: "oawm/t-1", mrTarget: "main" }]);
    await g.pushBase("/repo", "main");
    expect(g.pushedBases).toEqual(["main"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fakes.test.ts`
Expected: FAIL — `mergeBaseIntoBranch` etc. not on `FakeGit` / not on the interface (type error or runtime).

- [ ] **Step 3: Add the interface methods**

In `src/core/ports.ts`, replace the `GitBackend` interface body with (keeps the existing `merge`/`hasUncommittedOrUnmerged` for now — removed in Task 5):
```ts
export interface GitBackend {
  createWorktree(repoPath: string, branch: string, dir: string, baseBranch: string): Promise<void>;
  diff(repoPath: string, baseBranch: string, branch: string): Promise<string>;
  merge(repoPath: string, baseBranch: string, branch: string): Promise<{ ok: boolean; conflicts: boolean; message: string }>;
  removeWorktree(repoPath: string, dir: string, opts: { force: boolean }): Promise<{ ok: boolean; reason?: string }>;
  hasUncommittedOrUnmerged(repoPath: string, dir: string, baseBranch: string, branch: string): Promise<boolean>;
  mergeBaseIntoBranch(worktreePath: string, base: string): Promise<{ ok: boolean; conflicts: boolean; inProgress: boolean; message: string }>;
  worktreeDirty(worktreePath: string): Promise<boolean>;
  fastForwardBase(repoPath: string, base: string, branch: string): Promise<{ ok: boolean; reason?: string }>;
  pushBranch(repoPath: string, branch: string, opts?: { mrTarget?: string }): Promise<{ ok: boolean; message: string }>;
  pushBase(repoPath: string, base: string): Promise<{ ok: boolean; message: string }>;
  getRemoteUrl(repoPath: string): Promise<string>;
}
```

- [ ] **Step 4: Extend FakeGit**

In `tests/fakes.ts`, replace the `FakeGit` class with:
```ts
export class FakeGit implements GitBackend {
  worktrees = new Set<string>();
  merged: string[] = [];
  removeCalls: { dir: string; force: boolean }[] = [];
  integratedBase: string[] = [];
  fastForwarded: { base: string; branch: string }[] = [];
  pushedBranches: { branch: string; mrTarget?: string }[] = [];
  pushedBases: string[] = [];
  dirty = false;
  conflicts = false;
  inProgress = false;
  ffOk = true;
  pushBranchOk = true;
  pushBaseOk = true;
  remoteUrl = "git@github.com:acme/widget.git";

  async createWorktree(_r: string, _b: string, dir: string) { this.worktrees.add(dir); }
  async diff() { return "diff --git a b"; }
  async merge(_r: string, _base: string, branch: string) {
    this.merged.push(branch);
    return { ok: true, conflicts: false, message: "merged" };
  }
  async removeWorktree(_r: string, dir: string, opts: { force: boolean }) {
    this.removeCalls.push({ dir, force: opts.force });
    if (this.dirty && !opts.force) return { ok: false, reason: "dirty" };
    this.worktrees.delete(dir);
    return { ok: true };
  }
  async hasUncommittedOrUnmerged() { return this.dirty; }
  async mergeBaseIntoBranch(_wt: string, base: string) {
    this.integratedBase.push(base);
    return { ok: !this.conflicts && !this.inProgress, conflicts: this.conflicts, inProgress: this.inProgress, message: "" };
  }
  async worktreeDirty() { return this.dirty; }
  async fastForwardBase(_r: string, base: string, branch: string) {
    this.fastForwarded.push({ base, branch });
    return this.ffOk ? { ok: true } : { ok: false, reason: "blocked" };
  }
  async pushBranch(_r: string, branch: string, opts: { mrTarget?: string } = {}) {
    this.pushedBranches.push({ branch, mrTarget: opts.mrTarget });
    return { ok: this.pushBranchOk, message: "" };
  }
  async pushBase(_r: string, base: string) {
    this.pushedBases.push(base);
    return { ok: this.pushBaseOk, message: "" };
  }
  async getRemoteUrl() { return this.remoteUrl; }
}
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `npx vitest run tests/fakes.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/ports.ts tests/fakes.ts tests/fakes.test.ts
git commit -m "feat: GitBackend completion primitives + FakeGit recording"
```

---

### Task 3: CompletionCoordinator

**Files:**
- Create: `src/core/completion.ts`
- Test: `tests/completion.test.ts`

**Interfaces:**
- Consumes: `VaultGateway`, `GitBackend`, `MuxBackend`, `Notifier` (ports), `TaskNote`/`WorkspaceNote` + `worktreeDirName` (`src/domain/types.ts`), `parseRemote`/`compareUrl` (Task 1), all fakes (Task 2).
- Produces:
  - `class CompletionCoordinator` constructed with `{ vault, git, mux, notifier }`.
  - `merge(task: TaskNote, opts: { push: boolean }): Promise<void>`
  - `pushBranch(task: TaskNote): Promise<void>`
  - `openPr(task: TaskNote): Promise<{ url?: string }>`

- [ ] **Step 1: Write the failing test**

`tests/completion.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CompletionCoordinator } from "../src/core/completion";
import { FakeVault, FakeGit, FakeMux, FakeNotifier } from "./fakes";
import type { WorkspaceNote } from "../src/domain/types";

const ws: WorkspaceNote = {
  name: "W", repositories: [{ name: "repo", path: "/code/repo" }],
  isolation: "worktree", baseBranch: "main",
  git: { user: "V", email: "v@e" }, mux: { backend: "zellij" }, host: { type: "local" }, env: {},
};

function make() {
  const vault = new FakeVault();
  const git = new FakeGit();
  const mux = new FakeMux();
  const notifier = new FakeNotifier();
  vault.workspaces.set("W", ws);
  const c = new CompletionCoordinator({ vault, git, mux, notifier });
  return { vault, git, mux, notifier, c };
}

function seedActive(vault: FakeVault) {
  vault.seedTask({
    path: "T.md", id: "DS-1", title: "Add Thing", workspace: "W", repositories: ["repo"],
    agent: "vexa", status: "Running", agentState: "NeedsReview",
    branch: "oawm/ds-1-add-thing", worktree: "/code/repo/.oawm-worktrees/ds-1-add-thing", session: "oawm-DS-1",
  });
}

describe("CompletionCoordinator.merge", () => {
  it("clean merge: integrates base, fast-forwards, tears down, marks Completed", async () => {
    const { vault, git, mux, c } = make();
    seedActive(vault);
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    expect(git.integratedBase).toEqual(["main"]);
    expect(git.fastForwarded).toEqual([{ base: "main", branch: "oawm/ds-1-add-thing" }]);
    expect(git.removeCalls).toEqual([{ dir: "ds-1-add-thing", force: false }]);
    expect(mux.alive.has("oawm-DS-1")).toBe(false);
    const t = await vault.getTask("T.md");
    expect(t?.status).toBe("Completed");
    expect(t?.agentState).toBe("Idle");
    expect(t?.branch).toBe("");
  });

  it("merge & push: also pushes base", async () => {
    const { vault, git, c } = make();
    seedActive(vault);
    await c.merge((await vault.getTask("T.md"))!, { push: true });
    expect(git.pushedBases).toEqual(["main"]);
    expect((await vault.getTask("T.md"))?.status).toBe("Completed");
  });

  it("conflict: parks at NeedsReview, keeps worktree, no teardown", async () => {
    const { vault, git, c, notifier } = make();
    seedActive(vault);
    git.conflicts = true;
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    expect(git.fastForwarded).toEqual([]);
    expect(git.removeCalls).toEqual([]);
    const t = await vault.getTask("T.md");
    expect(t?.status).toBe("Running");
    expect(t?.agentState).toBe("NeedsReview");
    expect(notifier.notices.join(" ")).toMatch(/resolve in the task terminal/i);
  });

  it("in-progress merge: distinct message, no teardown", async () => {
    const { vault, git, c, notifier } = make();
    seedActive(vault);
    git.inProgress = true;
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    expect(git.removeCalls).toEqual([]);
    expect(notifier.notices.join(" ")).toMatch(/commit the in-progress merge/i);
  });

  it("blocked fast-forward: parks at NeedsReview, no teardown", async () => {
    const { vault, git, c } = make();
    seedActive(vault);
    git.ffOk = false;
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    expect(git.removeCalls).toEqual([]);
    expect((await vault.getTask("T.md"))?.agentState).toBe("NeedsReview");
  });

  it("uncommitted + confirm: force-removes the worktree", async () => {
    const { vault, git, notifier, c } = make();
    seedActive(vault);
    git.dirty = true;
    notifier.confirmAnswer = true;
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    expect(git.removeCalls).toEqual([{ dir: "ds-1-add-thing", force: true }]);
    expect((await vault.getTask("T.md"))?.status).toBe("Completed");
  });

  it("uncommitted + decline: aborts, no integration", async () => {
    const { vault, git, notifier, c } = make();
    seedActive(vault);
    git.dirty = true;
    notifier.confirmAnswer = false;
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    expect(git.integratedBase).toEqual([]);
    expect((await vault.getTask("T.md"))?.status).toBe("Running");
  });

  it("idempotent: agentState Idle returns immediately", async () => {
    const { vault, git, c } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", workspace: "W", status: "Completed", agentState: "Idle", branch: "oawm/ds-1-t" });
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    expect(git.integratedBase).toEqual([]);
  });
});

describe("CompletionCoordinator.pushBranch", () => {
  it("pushes the branch, no state change", async () => {
    const { vault, git, c } = make();
    seedActive(vault);
    await c.pushBranch((await vault.getTask("T.md"))!);
    expect(git.pushedBranches).toEqual([{ branch: "oawm/ds-1-add-thing", mrTarget: undefined }]);
    expect((await vault.getTask("T.md"))?.status).toBe("Running");
  });
});

describe("CompletionCoordinator.openPr", () => {
  it("GitHub: pushes branch and returns the compare URL", async () => {
    const { vault, git, c } = make();
    git.remoteUrl = "git@github.com:acme/widget.git";
    seedActive(vault);
    const res = await c.openPr((await vault.getTask("T.md"))!);
    expect(git.pushedBranches).toEqual([{ branch: "oawm/ds-1-add-thing", mrTarget: undefined }]);
    expect(res.url).toBe("https://github.com/acme/widget/compare/main...oawm/ds-1-add-thing?expand=1");
  });

  it("GitLab: pushes with merge_request options, no URL returned", async () => {
    const { vault, git, c } = make();
    git.remoteUrl = "git@gitlab.com:grp/proj.git";
    seedActive(vault);
    const res = await c.openPr((await vault.getTask("T.md"))!);
    expect(git.pushedBranches).toEqual([{ branch: "oawm/ds-1-add-thing", mrTarget: "main" }]);
    expect(res.url).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/completion.test.ts`
Expected: FAIL — `../src/core/completion` not found.

- [ ] **Step 3: Implement the coordinator**

`src/core/completion.ts`:
```ts
import { worktreeDirName } from "../domain/types";
import type { TaskNote, WorkspaceNote } from "../domain/types";
import type { VaultGateway, GitBackend, MuxBackend, Notifier } from "./ports";
import { parseRemote, compareUrl } from "./remote";

export interface CompletionDeps {
  vault: VaultGateway;
  git: GitBackend;
  mux: MuxBackend;
  notifier: Notifier;
}

function resolveRepoPath(task: TaskNote, ws: WorkspaceNote): string {
  const repo = ws.repositories.find((r) => r.name === task.repositories[0]) ?? ws.repositories[0];
  return repo.path;
}

const PUSH_DIRTY_WARNING = "worktree has uncommitted changes — only committed work will be pushed; uncommitted changes stay in the worktree. Continue?";

export class CompletionCoordinator {
  constructor(private deps: CompletionDeps) {}

  async merge(task: TaskNote, opts: { push: boolean }): Promise<void> {
    if (task.agentState === "Idle") return; // already completed
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) return;

    // repo-direct or missing branch/worktree: finalize without merging
    if (ws.isolation !== "worktree" || !task.branch || !task.worktree) {
      if (task.session) await this.deps.mux.kill(task.session);
      await this.deps.vault.patchTask(task.path, { status: "Completed", agentState: "Idle", session: "", branch: "", worktree: "" });
      return;
    }

    const repoPath = resolveRepoPath(task, ws);

    // Uncommitted check — finishing action discards on teardown, so confirm.
    let force = false;
    if (await this.deps.git.worktreeDirty(task.worktree)) {
      const ok = await this.deps.notifier.confirm(
        `Task ${task.id}: worktree has uncommitted changes that will be discarded when the worktree is removed after merge. Merge committed work and discard the rest?`,
      );
      if (!ok) return;
      force = true;
    }

    // Integrate base into the task branch (conflicts surface in the worktree).
    const integ = await this.deps.git.mergeBaseIntoBranch(task.worktree, ws.baseBranch);
    if (!integ.ok) {
      await this.deps.vault.patchTask(task.path, { agentState: "NeedsReview" });
      this.deps.notifier.notice(
        integ.inProgress
          ? `Task ${task.id}: finish resolving and commit the in-progress merge in the task terminal, then retry.`
          : `Task ${task.id}: merge conflict — resolve in the task terminal (Open Terminal), then click Merge again.`,
      );
      return;
    }

    // Advance base (guaranteed fast-forward).
    const ff = await this.deps.git.fastForwardBase(repoPath, ws.baseBranch, task.branch);
    if (!ff.ok) {
      await this.deps.vault.patchTask(task.path, { agentState: "NeedsReview" });
      this.deps.notifier.notice(`Task ${task.id}: could not fast-forward ${ws.baseBranch} (${ff.reason ?? "blocked"}). Resolve and retry.`);
      return;
    }

    if (opts.push) {
      const pushed = await this.deps.git.pushBase(repoPath, ws.baseBranch);
      if (!pushed.ok) this.deps.notifier.notice(`Task ${task.id}: merged locally but push failed: ${pushed.message}`);
    }

    if (task.session) await this.deps.mux.kill(task.session);
    await this.deps.git.removeWorktree(repoPath, worktreeDirName(task.id, task.title), { force });
    await this.deps.vault.patchTask(task.path, { status: "Completed", agentState: "Idle", session: "", branch: "", worktree: "" });
    this.deps.notifier.notice(opts.push ? `Task ${task.id}: merged into ${ws.baseBranch} and pushed` : `Task ${task.id}: merged into ${ws.baseBranch}`);
  }

  async pushBranch(task: TaskNote): Promise<void> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws || !task.branch) { this.deps.notifier.notice(`Task ${task.id}: no branch to push`); return; }
    if (!(await this.confirmPushIfDirty(task))) return;
    const res = await this.deps.git.pushBranch(resolveRepoPath(task, ws), task.branch);
    this.deps.notifier.notice(res.ok ? `Task ${task.id}: pushed ${task.branch}` : `Task ${task.id}: push failed: ${res.message}`);
  }

  async openPr(task: TaskNote): Promise<{ url?: string }> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws || !task.branch) { this.deps.notifier.notice(`Task ${task.id}: no branch for PR`); return {}; }
    if (!(await this.confirmPushIfDirty(task))) return {};
    const repoPath = resolveRepoPath(task, ws);
    const remote = parseRemote(await this.deps.git.getRemoteUrl(repoPath));

    if (remote.host === "gitlab") {
      const res = await this.deps.git.pushBranch(repoPath, task.branch, { mrTarget: ws.baseBranch });
      this.deps.notifier.notice(res.ok ? `Task ${task.id}: pushed ${task.branch} and requested MR` : `Task ${task.id}: push failed: ${res.message}`);
      return {};
    }

    const res = await this.deps.git.pushBranch(repoPath, task.branch);
    if (!res.ok) { this.deps.notifier.notice(`Task ${task.id}: push failed: ${res.message}`); return {}; }
    if (remote.host === "github") return { url: compareUrl(remote, ws.baseBranch, task.branch) };
    this.deps.notifier.notice(`Task ${task.id}: pushed ${task.branch} (open a PR/MR on your host)`);
    return {};
  }

  private async confirmPushIfDirty(task: TaskNote): Promise<boolean> {
    if (!task.worktree) return true;
    if (!(await this.deps.git.worktreeDirty(task.worktree))) return true;
    return this.deps.notifier.confirm(`Task ${task.id}: ${PUSH_DIRTY_WARNING}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/completion.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/completion.ts tests/completion.test.ts
git commit -m "feat: CompletionCoordinator (merge/push/openPr) over fakes"
```

---

### Task 4: RealGitBackend primitives

**Files:**
- Modify: `src/backends/git.ts` (add the six methods + a pure `findWorktreeForBranch` helper)
- Test: `tests/git.test.ts` (add real-temp-repo tests)

**Interfaces:**
- Consumes: `run` (`src/backends/exec.ts`), the `GitBackend` interface (Task 2).
- Produces on `RealGitBackend`: `mergeBaseIntoBranch`, `worktreeDirty`, `fastForwardBase`, `pushBranch`, `pushBase`, `getRemoteUrl`; plus exported pure `findWorktreeForBranch(porcelain: string, branch: string): string | null`.

- [ ] **Step 1: Write the failing test**

Append to `tests/git.test.ts` (it already imports `RealGitBackend`, `run`, `initRepo`, fs/path helpers):
```ts
import { findWorktreeForBranch } from "../src/backends/git";

describe("findWorktreeForBranch", () => {
  it("returns the worktree path for a branch", () => {
    const porcelain = [
      "worktree /code/repo", "HEAD aaa", "branch refs/heads/main", "",
      "worktree /code/repo/.oawm-worktrees/t-1", "HEAD bbb", "branch refs/heads/oawm/t-1", "",
    ].join("\n");
    expect(findWorktreeForBranch(porcelain, "main")).toBe("/code/repo");
    expect(findWorktreeForBranch(porcelain, "oawm/t-1")).toBe("/code/repo/.oawm-worktrees/t-1");
    expect(findWorktreeForBranch(porcelain, "absent")).toBeNull();
  });
});

describe("RealGitBackend completion primitives", () => {
  const git = new RealGitBackend();
  let repo: string;
  beforeEach(async () => { repo = await initRepo(); });

  it("worktreeDirty reflects uncommitted changes", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    expect(await git.worktreeDirty(wt)).toBe(false);
    writeFileSync(join(wt, "f.txt"), "wip\n");
    expect(await git.worktreeDirty(wt)).toBe(true);
  });

  it("mergeBaseIntoBranch integrates base cleanly", async () => {
    // advance base with a non-conflicting commit after the worktree branched
    writeFileSync(join(repo, "base.txt"), "base\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "base advance"], { cwd: repo });
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    // branch was created from main's tip BEFORE base advance? createWorktree uses baseBranch=main HEAD now.
    // Make a branch commit so it's a real --no-ff merge:
    writeFileSync(join(wt, "feat.txt"), "feat\n");
    await run("git", ["add", "."], { cwd: wt });
    await run("git", ["commit", "-m", "feat"], { cwd: wt });
    const res = await git.mergeBaseIntoBranch(wt, "main");
    expect(res.ok).toBe(true);
    expect(res.conflicts).toBe(false);
    expect(existsSync(join(wt, "base.txt"))).toBe(true); // base content now in the branch worktree
  });

  it("mergeBaseIntoBranch reports a real conflict without aborting", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    // both base and branch change README differently -> conflict on merge
    writeFileSync(join(repo, "README.md"), "base side\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "base edits readme"], { cwd: repo });
    writeFileSync(join(wt, "README.md"), "branch side\n");
    await run("git", ["add", "."], { cwd: wt });
    await run("git", ["commit", "-m", "branch edits readme"], { cwd: wt });
    const res = await git.mergeBaseIntoBranch(wt, "main");
    expect(res.ok).toBe(false);
    expect(res.conflicts).toBe(true);
    // merge left in progress (not aborted): MERGE_HEAD exists
    expect((await run("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: wt })).code).toBe(0);
    // a second call detects the in-progress merge
    const again = await git.mergeBaseIntoBranch(wt, "main");
    expect(again.inProgress).toBe(true);
  });

  it("fastForwardBase advances base checked out in another worktree", async () => {
    // main is checked out in `repo`; create a task worktree that's ahead, then ff main
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    writeFileSync(join(wt, "feat.txt"), "feat\n");
    await run("git", ["add", "."], { cwd: wt });
    await run("git", ["commit", "-m", "feat"], { cwd: wt });
    const res = await git.fastForwardBase(repo, "main", "oawm/x");
    expect(res.ok).toBe(true);
    expect(existsSync(join(repo, "feat.txt"))).toBe(true); // main (in `repo`) advanced
  });

  it("getRemoteUrl returns the origin url", async () => {
    await run("git", ["remote", "add", "origin", "git@github.com:o/r.git"], { cwd: repo });
    expect(await git.getRemoteUrl(repo)).toBe("git@github.com:o/r.git");
  });

  it("pushBranch and pushBase push to a local bare remote", async () => {
    const bare = mkdtempSync(join(tmpdir(), "oawm-bare-"));
    await run("git", ["init", "--bare", "-b", "main"], { cwd: bare });
    await run("git", ["remote", "add", "origin", bare], { cwd: repo });
    const pb = await git.pushBase(repo, "main");
    expect(pb.ok).toBe(true);
    // a branch push lands too
    await run("git", ["branch", "oawm/x"], { cwd: repo });
    const pbr = await git.pushBranch(repo, "oawm/x");
    expect(pbr.ok).toBe(true);
    const refs = await run("git", ["ls-remote", "--heads", bare], { cwd: repo });
    expect(refs.stdout).toContain("oawm/x");
  });
});
```
Note: `mkdtempSync`/`tmpdir` are already imported at the top of `tests/git.test.ts`; if not, add them to the existing `node:fs`/`node:os` imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git.test.ts`
Expected: FAIL — `findWorktreeForBranch` / new methods not defined.

- [ ] **Step 3: Implement the primitives**

In `src/backends/git.ts`, add the exported helper above the class:
```ts
export function findWorktreeForBranch(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split(/\n\s*\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const br = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (path && br === branch) return path;
  }
  return null;
}
```
Add these methods to the `RealGitBackend` class body:
```ts
  async mergeBaseIntoBranch(worktreePath: string, base: string): Promise<{ ok: boolean; conflicts: boolean; inProgress: boolean; message: string }> {
    const inProgress = (await run("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: worktreePath })).code === 0;
    if (inProgress) return { ok: false, conflicts: true, inProgress: true, message: "a merge is already in progress" };
    const res = await run("git", ["merge", "--no-ff", base], { cwd: worktreePath });
    const conflicts = /CONFLICT/i.test(res.stdout + res.stderr);
    if (res.code !== 0) return { ok: false, conflicts, inProgress: false, message: res.stdout + res.stderr };
    return { ok: true, conflicts: false, inProgress: false, message: res.stdout };
  }

  async worktreeDirty(worktreePath: string): Promise<boolean> {
    const res = await run("git", ["status", "--porcelain"], { cwd: worktreePath });
    return res.stdout.trim().length > 0;
  }

  async fastForwardBase(repoPath: string, base: string, branch: string): Promise<{ ok: boolean; reason?: string }> {
    const list = await run("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
    const baseWt = findWorktreeForBranch(list.stdout, base);
    if (baseWt) {
      const res = await run("git", ["merge", "--ff-only", branch], { cwd: baseWt });
      if (res.code !== 0) return { ok: false, reason: (res.stderr || res.stdout).trim() };
      return { ok: true };
    }
    const res = await run("git", ["branch", "-f", base, branch], { cwd: repoPath });
    if (res.code !== 0) return { ok: false, reason: res.stderr.trim() };
    return { ok: true };
  }

  async pushBranch(repoPath: string, branch: string, opts: { mrTarget?: string } = {}): Promise<{ ok: boolean; message: string }> {
    const args = ["push", "-u"];
    if (opts.mrTarget) args.push("-o", "merge_request.create", "-o", `merge_request.target=${opts.mrTarget}`);
    args.push("origin", branch);
    const res = await run("git", args, { cwd: repoPath });
    return { ok: res.code === 0, message: (res.stdout + res.stderr).trim() };
  }

  async pushBase(repoPath: string, base: string): Promise<{ ok: boolean; message: string }> {
    const res = await run("git", ["push", "origin", base], { cwd: repoPath });
    return { ok: res.code === 0, message: (res.stdout + res.stderr).trim() };
  }

  async getRemoteUrl(repoPath: string): Promise<string> {
    const res = await run("git", ["remote", "get-url", "origin"], { cwd: repoPath });
    return res.stdout.trim();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git.test.ts`
Expected: PASS (requires `git` on PATH).

- [ ] **Step 5: Commit**

```bash
git add src/backends/git.ts tests/git.test.ts
git commit -m "feat: RealGitBackend completion primitives over real git"
```

---

### Task 5: Wire orchestrator to the coordinator + remove dead merge primitives

**Files:**
- Modify: `src/core/orchestrator.ts` (delegate `completeAndMerge`, add `completion` dep)
- Modify: `src/core/ports.ts` (remove `merge`, `hasUncommittedOrUnmerged`)
- Modify: `src/backends/git.ts` (remove `merge`, `hasUncommittedOrUnmerged`)
- Modify: `tests/fakes.ts` (remove `merge`/`hasUncommittedOrUnmerged` from `FakeGit`)
- Modify: `tests/git.test.ts` (remove the old `merge`/`hasUncommittedOrUnmerged` test blocks)
- Modify: `tests/orchestrator.test.ts` (provide a `completion` in deps; adjust the merge-path assertions)

**Interfaces:**
- Consumes: `CompletionCoordinator` (Task 3).
- Produces: `Orchestrator` constructor `deps` gains `completion: CompletionCoordinator`; `completeAndMerge` becomes a one-line delegation.

- [ ] **Step 1: Update the orchestrator test to the delegation shape (failing)**

In `tests/orchestrator.test.ts`, import the coordinator and add it to the deps built in the test's `make()` helper. At the top:
```ts
import { CompletionCoordinator } from "../src/core/completion";
```
In `make()`, after constructing `notifier`, build the coordinator and pass it to the orchestrator:
```ts
  const completion = new CompletionCoordinator({ vault, git, mux, notifier });
  const orch = new Orchestrator({ vault, git, mux, agent: agentBackend, notifier, vaultRoot: "/vault", completion });
```
Replace the existing "merges and removes worktree on Completed when clean" and "refuses worktree removal with dirty work" assertions so they assert via the coordinator's effects on the fakes (the coordinator now owns merge):
```ts
  it("delegates Completed to the coordinator: integrates, ff, tears down", async () => {
    const { vault, git, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md");                 // launch -> Running
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md");
    expect(git.integratedBase).toEqual(["main"]);
    expect(git.fastForwarded).toEqual([{ base: "main", branch: "oawm/ds-1-t" }]);
    expect(git.removeCalls.some((c) => c.dir === "ds-1-t")).toBe(true);
    expect((await vault.getTask("T.md"))?.status).toBe("Completed");
  });

  it("Completed with dirty worktree + decline: no integration, stays Running", async () => {
    const { vault, git, notifier, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md");
    git.dirty = true;
    notifier.confirmAnswer = false;
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md");
    expect(git.integratedBase).toEqual([]);
  });
```
(Remove the two prior tests these replace — "merges and removes worktree on Completed when clean" and "refuses worktree removal with dirty work unless confirmed" — and any `git.merged` assertions, since `merge` is gone.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL — `Orchestrator` deps has no `completion`; `completeAndMerge` still uses old logic.

- [ ] **Step 3: Delegate in the orchestrator**

In `src/core/orchestrator.ts`:
1. Add the import: `import type { CompletionCoordinator } from "./completion";`
2. Add to `OrchestratorDeps`: `completion: CompletionCoordinator;`
3. Replace the entire `completeAndMerge` method body with a delegation:
```ts
  private async completeAndMerge(task: TaskNote): Promise<void> {
    await this.deps.completion.merge(task, { push: false });
  }
```
(Leave the `decide()` → `offerMerge` → `completeAndMerge` wiring as-is; `merge`'s own `agentState === "Idle"` guard prevents re-entry.)

- [ ] **Step 4: Remove the now-dead primitives**

- In `src/core/ports.ts`, delete the `merge(...)` and `hasUncommittedOrUnmerged(...)` lines from `GitBackend`.
- In `src/backends/git.ts`, delete the `merge(...)` and `hasUncommittedOrUnmerged(...)` methods.
- In `tests/fakes.ts`, delete `merge(...)`, `hasUncommittedOrUnmerged(...)`, and the now-unused `merged` field from `FakeGit`.
- In `tests/git.test.ts`, delete the test blocks that call `git.merge(...)` and `git.hasUncommittedOrUnmerged(...)` (the new primitives cover the replacement behavior).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/orchestrator.ts src/core/ports.ts src/backends/git.ts tests/fakes.ts tests/git.test.ts tests/orchestrator.test.ts
git commit -m "refactor: orchestrator delegates merge to CompletionCoordinator; drop dead git.merge primitives"
```

---

### Task 6: Action bar buttons

**Files:**
- Modify: `src/obsidian/taskCodeBlock.ts` (`ActionId`, `availableActions`, `LABELS`)
- Modify: `tests/actionBar.test.ts`

**Interfaces:**
- Consumes: `TaskNote`.
- Produces: `ActionId = "start" | "openTerminal" | "viewDiff" | "merge" | "mergePush" | "push" | "openPr" | "cancel" | "restart"` (drops `"complete"`); `availableActions` returns the four git actions for active states that have a branch.

- [ ] **Step 1: Update the action-bar test (failing)**

Replace the body of `tests/actionBar.test.ts` with:
```ts
import { describe, it, expect } from "vitest";
import { availableActions } from "../src/obsidian/taskCodeBlock";
import type { TaskNote } from "../src/domain/types";

const base: TaskNote = {
  path: "T.md", id: "DS-1", title: "T", workspace: "W", repositories: ["repo"],
  agent: "vexa", status: "Pending", agentState: "", worktree: "", branch: "", session: "",
};
const active = (agentState: TaskNote["agentState"], extra: Partial<TaskNote> = {}): TaskNote =>
  ({ ...base, status: "Running", agentState, branch: "oawm/ds-1-t", session: "oawm-DS-1", ...extra });

describe("availableActions", () => {
  it("Pending → start", () => {
    expect(availableActions(base)).toEqual(["start"]);
  });
  it("active (NeedsReview) → terminal, diff, the four git actions, cancel", () => {
    expect(availableActions(active("NeedsReview")))
      .toEqual(["openTerminal", "viewDiff", "merge", "mergePush", "push", "openPr", "cancel"]);
  });
  it("active (Waiting) → same git actions available", () => {
    expect(availableActions(active("Waiting")))
      .toEqual(["openTerminal", "viewDiff", "merge", "mergePush", "push", "openPr", "cancel"]);
  });
  it("active (Running) → git actions available (branch exists)", () => {
    expect(availableActions(active("Running")))
      .toEqual(["openTerminal", "viewDiff", "merge", "mergePush", "push", "openPr", "cancel"]);
  });
  it("Failed with a session → openTerminal + restart + cancel (no git actions)", () => {
    expect(availableActions(active("Failed")))
      .toEqual(["openTerminal", "restart", "cancel"]);
  });
  it("active but no branch yet → no git actions", () => {
    expect(availableActions({ ...active("Running"), branch: "" }))
      .toEqual(["openTerminal", "viewDiff", "cancel"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/actionBar.test.ts`
Expected: FAIL — actions still return `"complete"`.

- [ ] **Step 3: Update `availableActions` and labels**

In `src/obsidian/taskCodeBlock.ts`:
1. Change the `ActionId` type:
```ts
export type ActionId = "start" | "openTerminal" | "viewDiff" | "merge" | "mergePush" | "push" | "openPr" | "cancel" | "restart";
```
2. Replace `stateActions` and `availableActions` with:
```ts
const GIT_ACTIONS: ActionId[] = ["merge", "mergePush", "push", "openPr"];

function stateActions(task: TaskNote): ActionId[] {
  if (task.status === "Pending") return ["start"];
  if (task.status === "Cancelled" || task.status === "Completed") return ["start"];
  // status === "Running"
  if (task.agentState === "Failed") return ["restart", "cancel"];
  // Running / Waiting / NeedsReview / "" → active
  const git = task.branch ? GIT_ACTIONS : [];
  return ["openTerminal", "viewDiff", ...git, "cancel"];
}

export function availableActions(task: TaskNote): ActionId[] {
  const actions = stateActions(task);
  if (task.session && !actions.includes("openTerminal")) {
    return ["openTerminal", ...actions];
  }
  return actions;
}
```
3. Update the `LABELS` map: remove `complete`, add the four:
```ts
const LABELS: Record<ActionId, string> = {
  start: "Start", openTerminal: "Open Terminal", viewDiff: "View Diff",
  merge: "Merge", mergePush: "Merge & Push", push: "Push", openPr: "Open PR/MR",
  cancel: "Cancel", restart: "Restart",
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/actionBar.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (main.ts still references `complete` — expected to fail here)**

Run: `npm run typecheck`
Expected: FAIL in `src/main.ts` (its `handleAction` switch still has `case "complete"`). This is fixed in Task 7. Do not fix it here.

- [ ] **Step 6: Commit**

```bash
git add src/obsidian/taskCodeBlock.ts tests/actionBar.test.ts
git commit -m "feat: four git-action buttons in the task action bar"
```

---

### Task 7: Wire main.ts + manual checklist

**Files:**
- Modify: `src/main.ts` (construct `CompletionCoordinator`, route the four actions, open PR URLs)
- Modify: `docs/MANUAL-TEST.md`

**Interfaces:**
- Consumes: `CompletionCoordinator` (Task 3), `ActionId` (Task 6).

- [ ] **Step 1: Construct the coordinator and pass it to the orchestrator**

In `src/main.ts`:
1. Add imports:
```ts
import { CompletionCoordinator } from "./core/completion";
```
2. Add a field: `private completion!: CompletionCoordinator;`
3. In `onload`, after `notifier` is created and before constructing the orchestrator, build the coordinator and include it in the orchestrator deps:
```ts
    this.completion = new CompletionCoordinator({ vault: this.vault, git: this.git, mux: this.mux, notifier });
    const agent = new ClaudeBackend({ mux: this.mux, hookHelperPath, statusDir: this.statusDir });
    this.orchestrator = new Orchestrator({ vault: this.vault, git: this.git, mux: this.mux, agent, notifier, vaultRoot, completion: this.completion });
```

- [ ] **Step 2: Route the four actions in `handleAction`**

Replace the `handleAction` method in `src/main.ts` with:
```ts
  private async handleAction(action: ActionId, task: TaskNote) {
    switch (action) {
      case "start": await this.vault.patchTask(task.path, { status: "Running" }); break;
      case "cancel": await this.vault.patchTask(task.path, { status: "Cancelled" }); break;
      case "restart": await this.vault.patchTask(task.path, { agentState: "", status: "Running" }); break;
      case "openTerminal": if (task.session) await this.mux.focus(task.session); return;
      case "viewDiff": await this.showDiff(task); return;
      case "merge": await this.completion.merge(task, { push: false }); return;
      case "mergePush": await this.completion.merge(task, { push: true }); return;
      case "push": await this.completion.pushBranch(task); return;
      case "openPr": {
        const { url } = await this.completion.openPr(task);
        if (url) {
          const { shell } = require("electron");
          shell.openExternal(url);
        }
        return;
      }
    }
    await this.orchestrator.reconcileTask(task.path);
  }
```

- [ ] **Step 3: Typecheck, build, full suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: typecheck clean; `main.js` produced; all tests PASS.

- [ ] **Step 4: Update the manual checklist**

In `docs/MANUAL-TEST.md`, replace the old "Complete & Merge" step (step 6) with:
```md
6. With committed work on the task branch, the action bar shows **Merge / Merge & Push / Push / Open PR/MR**:
   - [ ] **Merge** → task branch integrates base in the task worktree, base fast-forwards (your main checkout is not disturbed), worktree is removed, task → Completed.
   - [ ] Force a conflict (edit the same line on base and the branch) → **Merge** parks the task at NeedsReview and the conflict is left in the task worktree; resolve + commit in the terminal, **Merge** again → completes.
   - [ ] Leave an uncommitted change in the worktree → **Merge** warns it will be discarded; declining keeps the task; confirming merges and force-removes the worktree.
   - [ ] **Merge & Push** → also pushes the base branch to origin.
   - [ ] **Push** → pushes the task branch to origin; task stays active.
   - [ ] **Open PR/MR** → GitHub: opens the prefilled compare URL in the browser; GitLab: pushes with merge_request options (creates the MR).
```

- [ ] **Step 5: Commit**

```bash
git add src/main.ts docs/MANUAL-TEST.md
git commit -m "feat: wire completion actions into the plugin (merge/push/PR) + manual checklist"
```

---

## Self-Review

**Spec coverage:**
- Four action buttons in the task item → Task 6 (`availableActions`/`LABELS`), Task 7 (routing). ✓
- Imperative, not desired-state → Task 7 routes to coordinator directly; Task 5 keeps the `status: Completed` path delegating to the same `merge`. ✓
- Merge mechanics Approach B (integrate base in task worktree → ff base) → Task 3 (coordinator order), Task 4 (`mergeBaseIntoBranch`, `fastForwardBase`). ✓
- Conflicts in the task worktree, no abort, NeedsReview + retry; in-progress detection → Task 3 (state writes/notices), Task 4 (`mergeBaseIntoBranch` MERGE_HEAD detection, no abort). ✓
- Never disrupt main checkout / never force ff → Task 4 `fastForwardBase` uses ff-only in base's worktree or `branch -f`; reports on block. ✓
- Uncommitted warning, finishing force-discard only on confirm → Task 3 (`merge` confirm→force, `confirmPushIfDirty`). ✓
- Push / Open PR raw git; GitLab push options; GitHub compare URL; unknown host push-only → Task 1 (`parseRemote`/`compareUrl`), Task 3 (`openPr` host branch), Task 4 (`pushBranch` `mrTarget`). ✓
- Open URL via Electron `shell.openExternal` → Task 7. ✓
- Components: `remote.ts`, `CompletionCoordinator`, GitBackend primitives, orchestrator delegation, action bar, main wiring → Tasks 1–7. ✓
- Remove old `merge`/`hasUncommittedOrUnmerged` → Task 5. ✓
- Testing: pure unit + fakes + real-temp-repo + manual → Tasks 1–6 automated, Task 7 manual. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete. Task 6 Step 5 intentionally expects a typecheck failure (cross-task seam with Task 7) and says so explicitly.

**Type consistency:** `mergeBaseIntoBranch` returns `{ ok, conflicts, inProgress, message }` in the interface (Task 2), fake (Task 2), real impl (Task 4), and consumer (Task 3). `fastForwardBase`/`pushBranch`/`pushBase`/`getRemoteUrl`/`worktreeDirty` signatures match across ports, fake, real, and coordinator. `ActionId` values (`merge`/`mergePush`/`push`/`openPr`) are identical in Task 6's type, `LABELS`, `availableActions`, and Task 7's `handleAction`. `CompletionCoordinator` constructor shape `{ vault, git, mux, notifier }` matches in Tasks 3, 5 (orchestrator test), and 7.

**Note on Task 4 test:** the clean-merge test advances base *after* the worktree is created, and the conflict test edits the same file on both sides — both produce a real `--no-ff` merge / conflict so the assertions exercise real git, not a no-op.
