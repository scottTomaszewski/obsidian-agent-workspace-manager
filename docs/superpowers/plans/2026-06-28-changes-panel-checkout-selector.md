# Changes Panel — Per-Repo Checkout Selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Changes panel select changes per-repo across a unified list of *checkouts* — each repo's main/base checkout plus its task worktrees — with a changeable, searchable base-ref for the comparison.

**Architecture:** Introduce a pure `CheckoutTarget` model (`src/core/targets.ts`) that treats a repo's main checkout and a task worktree as the same shape. The Changes panel (`src/obsidian/changesView.ts`) becomes a master/detail tree grouped by repo over these targets; the existing detail view (Local working-tree + diff-vs-base) renders any target, with commit/push routed by target kind. A new `GitBackend.searchBranches` powers an Orca-style `vs <baseRef>` picker whose pin persists per repo in plugin settings.

**Tech Stack:** TypeScript, Vitest, esbuild, Obsidian plugin API, raw `git` via `src/backends/exec.ts`.

## Global Constraints

- Layering: decision logic stays pure in `src/core`/`src/domain` and is unit-tested; `ItemView` DOM stays thin and has **no node tests** (verify via `npm run typecheck` + `npm run build` + manual steps).
- Ports/adapters: a new side-effecting capability is added to the interface in `src/core/ports.ts`, implemented in the matching `src/backends/*` adapter, and mirrored in the fake in `tests/fakes.ts` so it still satisfies the interface.
- `GitBackend` methods return result objects and never throw to the UI; user-facing messages go through `Notifier`.
- Git: raw `git` only (no `gh`/`glab`); base branch is per-workspace via `WorkspaceNote.baseBranch` — never assume `main`. Worktrees live outside the vault — never open them via the Obsidian Vault API / `TFile`.
- TDD: write the failing test first for `src/core`/`src/domain`/`src/backends` work.
- Done gate for code changes: `npm run typecheck` clean + `npm test` green + `npm run build` emits `main.js`.
- No AI/Claude attribution in commit messages.

---

## File Structure

- **Create:** `src/core/targets.ts` — `CheckoutTarget` type, `buildTargets`, `resolveBaseRef` (pure).
- **Create:** `tests/targets.test.ts`, extend `tests/commit.test.ts`, `tests/git.test.ts`, `tests/fakes.test.ts`.
- **Modify:** `src/core/ports.ts` — add `VaultGateway.listWorkspaces`, `GitBackend.searchBranches`.
- **Modify:** `src/backends/git.ts` — implement `searchBranches`.
- **Modify:** `src/obsidian/vaultGateway.ts` — implement `listWorkspaces`.
- **Modify:** `tests/fakes.ts` — `FakeVault.listWorkspaces`, `FakeGit.searchBranches`.
- **Modify:** `src/core/commit.ts` — extract per-repo commit core, add `commitTarget`.
- **Modify:** `src/obsidian/changesView.ts` — overview tree + target detail + base-ref control (full rewrite).
- **Modify:** `src/main.ts` — `pinnedBaseRefs` setting, new `ChangesView` deps, `openEditor` signature.
- **Modify:** `ARCHITECTURE.md`, `docs/gotchas.md`, `docs/MANUAL-TEST.md`, `CHANGELOG.md`.

---

## Task 1: Pure `CheckoutTarget` model

**Files:**
- Create: `src/core/targets.ts`
- Test: `tests/targets.test.ts`

**Interfaces:**
- Consumes: `TaskNote`, `WorkspaceNote` from `src/domain/types`; `resolveTaskWorktrees` from `src/core/worktrees`.
- Produces:
  - `interface CheckoutTarget { repo: string; repoPath: string; path: string; branch: string; kind: "base" | "worktree"; defaultBaseRef: string; taskPath?: string; taskId?: string; taskTitle?: string; session?: string }`
  - `buildTargets(tasks: TaskNote[], workspaces: WorkspaceNote[]): Map<string, CheckoutTarget[]>`
  - `resolveBaseRef(target: CheckoutTarget, pinned: Record<string, string>): string`

- [ ] **Step 1: Write the failing test**

Create `tests/targets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTargets, resolveBaseRef } from "../src/core/targets";
import type { TaskNote, WorkspaceNote } from "../src/domain/types";

const ws: WorkspaceNote = {
  name: "W",
  repositories: [{ name: "web", path: "/code/web" }, { name: "api", path: "/code/api" }],
  isolation: "worktree", baseBranch: "main",
  git: { user: "u", email: "e" }, mux: { backend: "zellij" }, host: { type: "local" }, env: {},
};

const task = (over: Partial<TaskNote>): TaskNote => ({
  path: "T.md", id: "DS-1", title: "Add OAuth", workspace: "W", repositories: ["web"],
  agent: "vexa", status: "Running", agentState: "Running",
  worktree: "wt", branch: "oawm/ds-1-add-oauth", session: "s1", ...over,
});

describe("buildTargets", () => {
  it("emits one base target per repo even with zero tasks", () => {
    const groups = buildTargets([], [ws]);
    expect([...groups.keys()]).toEqual(["web", "api"]);
    expect(groups.get("web")).toEqual([
      { repo: "web", repoPath: "/code/web", path: "/code/web", branch: "main", kind: "base", defaultBaseRef: "origin/main" },
    ]);
  });

  it("appends a worktree target per task worktree, base first", () => {
    const groups = buildTargets([task({})], [ws]);
    expect(groups.get("web")).toEqual([
      { repo: "web", repoPath: "/code/web", path: "/code/web", branch: "main", kind: "base", defaultBaseRef: "origin/main" },
      {
        repo: "web", repoPath: "/code/web", path: "/code/web/.oawm-worktrees/ds-1-add-oauth",
        branch: "oawm/ds-1-add-oauth", kind: "worktree", defaultBaseRef: "main",
        taskPath: "T.md", taskId: "DS-1", taskTitle: "Add OAuth", session: "s1",
      },
    ]);
  });

  it("skips tasks without a branch or worktree", () => {
    const groups = buildTargets([task({ branch: "", worktree: "" })], [ws]);
    expect(groups.get("web")).toHaveLength(1); // base only
  });

  it("dedupes a repo shared across workspaces by path", () => {
    const ws2: WorkspaceNote = { ...ws, name: "W2", repositories: [{ name: "web", path: "/code/web" }] };
    const groups = buildTargets([], [ws, ws2]);
    expect(groups.get("web")).toHaveLength(1);
  });
});

describe("resolveBaseRef", () => {
  const target = buildTargets([], [ws]).get("web")![0];
  it("returns the default base ref when no pin", () => {
    expect(resolveBaseRef(target, {})).toBe("origin/main");
  });
  it("returns the pinned ref keyed by repo path", () => {
    expect(resolveBaseRef(target, { "/code/web": "release/1.0" })).toBe("release/1.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/targets.test.ts`
Expected: FAIL — cannot find module `../src/core/targets`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/targets.ts`:

```ts
import type { TaskNote, WorkspaceNote } from "../domain/types";
import { resolveTaskWorktrees } from "./worktrees";

export interface CheckoutTarget {
  repo: string;          // repo name
  repoPath: string;      // repo root path; the per-repo base-ref pin key
  path: string;          // checkout dir (= repoPath for base checkouts)
  branch: string;
  kind: "base" | "worktree";
  defaultBaseRef: string;
  taskPath?: string;
  taskId?: string;
  taskTitle?: string;
  session?: string;
}

/** Group every checkout (each repo's base checkout + each task worktree) by repo name. */
export function buildTargets(tasks: TaskNote[], workspaces: WorkspaceNote[]): Map<string, CheckoutTarget[]> {
  const groups = new Map<string, CheckoutTarget[]>();
  const seenBase = new Set<string>(); // repo paths already given a base target
  const ensure = (repo: string): CheckoutTarget[] => {
    let arr = groups.get(repo);
    if (!arr) { arr = []; groups.set(repo, arr); }
    return arr;
  };

  for (const ws of workspaces) {
    for (const repo of ws.repositories) {
      if (seenBase.has(repo.path)) continue;
      seenBase.add(repo.path);
      ensure(repo.name).push({
        repo: repo.name, repoPath: repo.path, path: repo.path,
        branch: ws.baseBranch, kind: "base", defaultBaseRef: `origin/${ws.baseBranch}`,
      });
    }
  }

  for (const task of tasks) {
    if (!task.branch || !task.worktree) continue;
    const ws = workspaces.find((w) => w.name === task.workspace);
    if (!ws) continue;
    for (const wt of resolveTaskWorktrees(task, ws)) {
      const repoPath = ws.repositories.find((r) => r.name === wt.repo)?.path ?? wt.path;
      ensure(wt.repo).push({
        repo: wt.repo, repoPath, path: wt.path, branch: wt.branch, kind: "worktree",
        defaultBaseRef: ws.baseBranch, taskPath: task.path, taskId: task.id,
        taskTitle: task.title, session: task.session || undefined,
      });
    }
  }
  return groups;
}

/** Pinned base ref (keyed by repo path) wins over the target's default. */
export function resolveBaseRef(target: CheckoutTarget, pinned: Record<string, string>): string {
  return pinned[target.repoPath] ?? target.defaultBaseRef;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/targets.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/targets.ts tests/targets.test.ts
git commit -m "feat(core): CheckoutTarget model for the changes panel"
```

---

## Task 2: `VaultGateway.listWorkspaces`

**Files:**
- Modify: `src/core/ports.ts` (add to `VaultGateway`)
- Modify: `src/obsidian/vaultGateway.ts` (implement)
- Modify: `tests/fakes.ts` (`FakeVault`)
- Test: `tests/fakes.test.ts`

**Interfaces:**
- Produces: `VaultGateway.listWorkspaces(): Promise<WorkspaceNote[]>`; `FakeVault.listWorkspaces()` returns seeded `workspaces` values.

- [ ] **Step 1: Write the failing test**

Add to `tests/fakes.test.ts` inside the `describe("fakes", ...)` block:

```ts
  it("vault lists seeded workspaces", async () => {
    const v = new FakeVault();
    const ws = {
      name: "W", repositories: [{ name: "web", path: "/code/web" }],
      isolation: "worktree" as const, baseBranch: "main",
      git: { user: "u", email: "e" }, mux: { backend: "zellij" as const },
      host: { type: "local" as const }, env: {},
    };
    v.workspaces.set("W", ws);
    expect(await v.listWorkspaces()).toEqual([ws]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fakes.test.ts`
Expected: FAIL — `v.listWorkspaces is not a function`.

- [ ] **Step 3: Add the port method**

In `src/core/ports.ts`, add to the `VaultGateway` interface (after `getWorkspace`):

```ts
  listWorkspaces(): Promise<WorkspaceNote[]>;
```

- [ ] **Step 4: Implement on the real gateway**

In `src/obsidian/vaultGateway.ts`, add this method to `ObsidianVaultGateway` (next to `getWorkspace`):

```ts
  async listWorkspaces(): Promise<WorkspaceNote[]> {
    return this.filesOfType("workspace").map((f) =>
      frontmatterToWorkspace(f.basename, this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}));
  }
```

- [ ] **Step 5: Implement on the fake**

In `tests/fakes.ts`, add to `FakeVault` (after `getWorkspace`):

```ts
  async listWorkspaces() { return [...this.workspaces.values()]; }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/fakes.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/ports.ts src/obsidian/vaultGateway.ts tests/fakes.ts tests/fakes.test.ts
git commit -m "feat(vault): listWorkspaces port + impl + fake"
```

---

## Task 3: `GitBackend.searchBranches`

**Files:**
- Modify: `src/core/ports.ts` (add to `GitBackend`)
- Modify: `src/backends/git.ts` (implement)
- Modify: `tests/fakes.ts` (`FakeGit`)
- Test: `tests/git.test.ts`

**Interfaces:**
- Produces: `GitBackend.searchBranches(repoPath: string, query: string, limit: number): Promise<string[]>` — local + remote short refnames containing `query` (case-insensitive), capped at `limit`, `[]` on error.

- [ ] **Step 1: Write the failing test**

Add to `tests/git.test.ts` inside the `describe("RealGitBackend", ...)` block (it has `repo` + `git` in scope):

```ts
  it("searchBranches returns local + remote refs matching the query, capped", async () => {
    await git.createWorktree(repo, "feature/login", "f1", "main");
    await git.createWorktree(repo, "feature/logout", "f2", "main");
    const hits = await git.searchBranches(repo, "log", 10);
    expect(hits).toEqual(expect.arrayContaining(["feature/login", "feature/logout"]));
    expect(hits).not.toContain("main");
    expect(await git.searchBranches(repo, "nope-no-match", 10)).toEqual([]);
    expect((await git.searchBranches(repo, "feature", 1)).length).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git.test.ts -t searchBranches`
Expected: FAIL — `git.searchBranches is not a function`.

- [ ] **Step 3: Add the port method**

In `src/core/ports.ts`, add to the `GitBackend` interface (after `unmergedCounts`):

```ts
  searchBranches(repoPath: string, query: string, limit: number): Promise<string[]>;
```

- [ ] **Step 4: Implement on the real backend**

In `src/backends/git.ts`, add to `RealGitBackend` (after `unmergedCounts`):

```ts
  async searchBranches(repoPath: string, query: string, limit: number): Promise<string[]> {
    const res = await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { cwd: repoPath });
    if (res.code !== 0) return [];
    const q = query.toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const ref of res.stdout.split("\n")) {
      const name = ref.trim();
      if (name.length === 0 || name.endsWith("/HEAD")) continue;
      if (!name.toLowerCase().includes(q)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= limit) break;
    }
    return out;
  }
```

- [ ] **Step 5: Implement on the fake**

In `tests/fakes.ts`, add a seedable field + method to `FakeGit`. Add the field near the other fields (e.g. after `remoteUrl`):

```ts
  branches: string[] = [];
```

and the method (after `unmergedCounts`):

```ts
  async searchBranches(_r: string, query: string, limit: number) {
    return this.branches.filter((b) => b.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/git.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/ports.ts src/backends/git.ts tests/fakes.ts tests/git.test.ts
git commit -m "feat(git): searchBranches port + impl + fake"
```

---

## Task 4: `CommitCoordinator.commitTarget`

**Files:**
- Modify: `src/core/commit.ts`
- Test: `tests/commit.test.ts`

**Interfaces:**
- Consumes: `CheckoutTarget` from `src/core/targets`.
- Produces: `CommitCoordinator.commitTarget(target: CheckoutTarget, input: { paths: string[]; message: string; push: boolean }): Promise<RepoResult[]>` — commits the given paths at `target.path`; push routes to `pushBase` for `kind: "base"`, `pushBranch` for `kind: "worktree"`. Returns a single-element `RepoResult[]`.

- [ ] **Step 1: Write the failing test**

Add to `tests/commit.test.ts` a new `describe` block (after the existing `CommitCoordinator.commit` block):

```ts
import type { CheckoutTarget } from "../src/core/targets";

describe("CommitCoordinator.commitTarget", () => {
  const worktreeTarget: CheckoutTarget = {
    repo: "web", repoPath: "/code/web", path: "/code/web/.oawm-worktrees/x",
    branch: "oawm/x", kind: "worktree", defaultBaseRef: "main", taskId: "DS-1",
  };
  const baseTarget: CheckoutTarget = {
    repo: "web", repoPath: "/code/web", path: "/code/web",
    branch: "main", kind: "base", defaultBaseRef: "origin/main",
  };

  it("commits at the worktree path and pushes the branch", async () => {
    const { git, coord } = setup();
    await coord.commitTarget(worktreeTarget, { paths: ["a.ts"], message: "m", push: true });
    expect(git.commitCalls).toEqual([{ worktree: "/code/web/.oawm-worktrees/x", paths: ["a.ts"], message: "m" }]);
    expect(git.pushedBranches.map((p) => p.branch)).toEqual(["oawm/x"]);
    expect(git.pushedBases).toEqual([]);
  });

  it("commits at the base checkout path and pushes via pushBase", async () => {
    const { git, coord } = setup();
    await coord.commitTarget(baseTarget, { paths: ["a.ts"], message: "m", push: true });
    expect(git.commitCalls).toEqual([{ worktree: "/code/web", paths: ["a.ts"], message: "m" }]);
    expect(git.pushedBases).toEqual(["main"]);
    expect(git.pushedBranches).toEqual([]);
  });

  it("does not push when push is false", async () => {
    const { git, coord } = setup();
    const res = await coord.commitTarget(baseTarget, { paths: ["a.ts"], message: "m", push: false });
    expect(git.pushedBases).toEqual([]);
    expect(res).toEqual([{ repo: "web", committed: true, pushed: false, commit: "abc1234" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commit.test.ts -t commitTarget`
Expected: FAIL — `coord.commitTarget is not a function`.

- [ ] **Step 3: Refactor the per-repo core and add `commitTarget`**

In `src/core/commit.ts`, add the import at the top (after the existing imports):

```ts
import type { CheckoutTarget } from "./targets";
```

Replace the per-repo loop body inside `commit` with a call to a shared helper, and add `commitTarget`. Specifically, change the body of the `for (const wt of resolveTaskWorktrees(task, ws))` loop from:

```ts
      const repoPaths = byRepo.get(wt.repo);
      if (!repoPaths || repoPaths.length === 0) continue;

      const c = await this.deps.git.commitPaths(wt.path, repoPaths, input.message);
      if (!c.ok) { results.push({ repo: wt.repo, committed: false, pushed: false, error: c.message }); continue; }

      if (!input.push) { results.push({ repo: wt.repo, committed: true, pushed: false, commit: c.commit }); continue; }

      const pr = await this.deps.git.pushBranch(wt.path, wt.branch);
      results.push({ repo: wt.repo, committed: true, pushed: pr.ok, commit: c.commit, error: pr.ok ? undefined : pr.message });
```

to:

```ts
      const repoPaths = byRepo.get(wt.repo);
      if (!repoPaths || repoPaths.length === 0) continue;
      results.push(await this.commitInCheckout(
        wt.path, wt.repo, repoPaths, input.message, input.push,
        () => this.deps.git.pushBranch(wt.path, wt.branch),
      ));
```

Then add these two methods to the `CommitCoordinator` class (after `commit`):

```ts
  async commitTarget(target: CheckoutTarget, input: { paths: string[]; message: string; push: boolean }): Promise<RepoResult[]> {
    const pushFn = target.kind === "base"
      ? () => this.deps.git.pushBase(target.path, target.branch)
      : () => this.deps.git.pushBranch(target.path, target.branch);
    const result = await this.commitInCheckout(target.path, target.repo, input.paths, input.message, input.push, pushFn);
    this.deps.notifier.notice(summarizeCommit(target.taskId ?? target.repo, [result]));
    return [result];
  }

  private async commitInCheckout(
    path: string, repo: string, paths: string[], message: string, push: boolean,
    pushFn: () => Promise<{ ok: boolean; message: string }>,
  ): Promise<RepoResult> {
    const c = await this.deps.git.commitPaths(path, paths, message);
    if (!c.ok) return { repo, committed: false, pushed: false, error: c.message };
    if (!push) return { repo, committed: true, pushed: false, commit: c.commit };
    const pr = await pushFn();
    return { repo, committed: true, pushed: pr.ok, commit: c.commit, error: pr.ok ? undefined : pr.message };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commit.test.ts`
Expected: PASS — both the existing `commit` cases and the new `commitTarget` cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/commit.ts tests/commit.test.ts
git commit -m "feat(commit): commitTarget for arbitrary checkouts"
```

---

## Task 5: Changes panel rewrite + composition wiring

This task has no node tests (thin `ItemView` + composition root). Verify with `npm run typecheck` + `npm run build` + the manual steps appended to `docs/MANUAL-TEST.md`. The view and `main.ts` are changed together so the repo typechecks at the commit.

**Files:**
- Modify: `src/obsidian/changesView.ts` (full rewrite)
- Modify: `src/main.ts` (`pinnedBaseRefs` setting, `ChangesView` deps, `openEditor` signature)
- Modify: `docs/MANUAL-TEST.md`

**Interfaces:**
- Consumes: `buildTargets`, `resolveBaseRef`, `CheckoutTarget` (Task 1); `VaultGateway.listWorkspaces` (Task 2); `GitBackend.searchBranches` (Task 3); `CommitCoordinator.commitTarget` (Task 4).
- Produces: `ChangesViewDeps` with `pinnedBaseRefs: () => Record<string, string>`, `setBaseRef: (repoPath: string, ref: string | null) => Promise<void>`, `openEditor: (dir: string, path: string, session: string | null) => Promise<void>`; `ChangesView.showTask(path: string | null)` (null → overview; a task path → that task's primary-repo worktree target).

- [ ] **Step 1: Rewrite `src/obsidian/changesView.ts`**

Replace the entire file with:

```ts
import { ItemView, WorkspaceLeaf } from "obsidian";
import type { VaultGateway, GitBackend } from "../core/ports";
import type { CompletionCoordinator } from "../core/completion";
import type { CommitCoordinator } from "../core/commit";
import { commitEnabled, type FileChange } from "../core/changes";
import { buildTargets, resolveBaseRef, type CheckoutTarget } from "../core/targets";

export const CHANGES_VIEW_TYPE = "oawm-changes";

export interface ChangesViewDeps {
  vault: VaultGateway;
  git: GitBackend;
  completion: CompletionCoordinator;
  commit: CommitCoordinator;
  pinnedBaseRefs: () => Record<string, string>;
  setBaseRef: (repoPath: string, ref: string | null) => Promise<void>;
  openDiff: (title: string, diff: string) => Promise<void>;
  openEditor: (dir: string, path: string, session: string | null) => Promise<void>;
  openExternal: (url: string) => void;
}

export class ChangesView extends ItemView {
  private activeTarget: { repo: string; path: string } | null = null;
  private tab: "local" | "diff" = "local";
  private checked = new Set<string>();   // file path within the active checkout
  private message = "";
  private baseRefEditing = false;
  private searchTimer?: number;

  constructor(leaf: WorkspaceLeaf, private deps: ChangesViewDeps) { super(leaf); }
  getViewType() { return CHANGES_VIEW_TYPE; }
  getDisplayText() { return "Workspace Changes"; }
  getIcon() { return "git-pull-request"; }

  async onOpen() { await this.render(); }

  /** Deep-link entry point: null → overview; a task path → its primary-repo worktree target. */
  async showTask(path: string | null) {
    this.resetDetailState();
    if (!path) { this.activeTarget = null; await this.render(); return; }
    const groups = await this.loadGroups();
    for (const list of groups.values()) {
      for (const t of list) {
        if (t.kind === "worktree" && t.taskPath === path) { this.activeTarget = { repo: t.repo, path: t.path }; await this.render(); return; }
      }
    }
    this.activeTarget = null;
    await this.render();
  }

  private async showTarget(target: CheckoutTarget) {
    this.resetDetailState();
    this.activeTarget = { repo: target.repo, path: target.path };
    await this.render();
  }

  private resetDetailState() {
    this.checked.clear();
    this.message = "";
    this.tab = "local";
    this.baseRefEditing = false;
  }

  private loadGroups() {
    return Promise.all([this.deps.vault.listTasks(), this.deps.vault.listWorkspaces()])
      .then(([tasks, workspaces]) => buildTargets(tasks, workspaces));
  }

  private findTarget(groups: Map<string, CheckoutTarget[]>, sel: { repo: string; path: string }): CheckoutTarget | null {
    for (const t of groups.get(sel.repo) ?? []) if (t.path === sel.path) return t;
    return null;
  }

  private async render() {
    const root = this.contentEl;
    root.empty();
    const groups = await this.loadGroups();
    if (!this.activeTarget) { await this.renderOverview(root, groups); return; }
    const target = this.findTarget(groups, this.activeTarget);
    if (!target) { this.activeTarget = null; await this.renderOverview(root, groups); return; }
    await this.renderTarget(root, target);
  }

  private async renderOverview(root: HTMLElement, groups: Map<string, CheckoutTarget[]>) {
    root.createEl("h4", { text: "Workspace Changes" });
    if (groups.size === 0) { root.createEl("em", { text: "No workspaces found." }); return; }
    const pinned = this.deps.pinnedBaseRefs();
    for (const [repo, targets] of groups) {
      root.createEl("div", { cls: "oawm-changes-repo", text: `▾ ${repo}` });
      for (const t of targets) {
        const row = root.createDiv({ cls: "oawm-changes-overrow" });
        const marker = t.kind === "base" ? "◆ " : "○ ";
        const label = t.kind === "base" ? t.branch : `${t.taskId} — ${t.taskTitle}`;
        const link = row.createEl("a", { text: marker + label, href: "#" });
        link.onclick = (e) => { e.preventDefault(); void this.showTarget(t); };
        const c = await this.countsFor(t, resolveBaseRef(t, pinned));
        row.createSpan({ cls: "oawm-changes-count", text: ` ● ${c.local} ↑ ${c.unmerged}` });
      }
    }
  }

  private async countsFor(target: CheckoutTarget, baseRef: string): Promise<{ local: number; unmerged: number }> {
    try { return await this.deps.git.unmergedCounts(target.path, baseRef); }
    catch { return { local: 0, unmerged: 0 }; }
  }

  private async collect(target: CheckoutTarget, scope: "local" | "diff", baseRef?: string): Promise<FileChange[]> {
    try {
      return scope === "local"
        ? await this.deps.git.status(target.path)
        : await this.deps.git.branchDiffFiles(target.path, baseRef!);
    } catch { return []; }
  }

  private async renderTarget(root: HTMLElement, target: CheckoutTarget) {
    const baseRef = resolveBaseRef(target, this.deps.pinnedBaseRefs());
    const header = root.createDiv({ cls: "oawm-changes-header" });
    const back = header.createEl("a", { text: "▲ ", href: "#" });
    back.onclick = (e) => { e.preventDefault(); void this.showTask(null); };
    const label = target.kind === "base" ? target.branch : `${target.taskId} — ${target.taskTitle}`;
    header.createSpan({ text: `${label} · ${target.branch}` });
    const refresh = header.createEl("button", { text: "⟳" });
    refresh.onclick = () => { void this.render(); };

    this.renderBaseRefControl(root, target, baseRef);

    const tabs = root.createDiv({ cls: "oawm-changes-tabs" });
    const localFiles = await this.collect(target, "local");
    const diffFiles = await this.collect(target, "diff", baseRef);
    this.tabButton(tabs, "local", `Local · ${localFiles.length}`);
    this.tabButton(tabs, "diff", `${baseRef} · ${diffFiles.length}`);

    const body = root.createDiv({ cls: "oawm-changes-body" });
    if (this.tab === "local") this.renderLocal(body, target, localFiles);
    else await this.renderDiff(body, target, diffFiles, baseRef);
  }

  private renderBaseRefControl(root: HTMLElement, target: CheckoutTarget, baseRef: string) {
    const bar = root.createDiv({ cls: "oawm-changes-baseref" });
    bar.createSpan({ text: "vs " });
    const btn = bar.createEl("a", { text: baseRef, href: "#" });
    btn.onclick = (e) => { e.preventDefault(); this.baseRefEditing = !this.baseRefEditing; void this.render(); };
    if (this.deps.pinnedBaseRefs()[target.repoPath]) {
      const useDefault = bar.createEl("a", { text: " (use default)", href: "#" });
      useDefault.onclick = async (e) => { e.preventDefault(); await this.deps.setBaseRef(target.repoPath, null); await this.render(); };
    }
    if (!this.baseRefEditing) return;
    const input = bar.createEl("input", { type: "text", attr: { placeholder: "Search branches…" } }) as HTMLInputElement;
    const results = bar.createDiv({ cls: "oawm-changes-baseref-results" });
    input.oninput = () => {
      const q = input.value.trim();
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(async () => {
        const refs = q.length < 1 ? [] : await this.deps.git.searchBranches(target.repoPath, q, 20);
        results.empty();
        for (const ref of refs) {
          const item = results.createEl("a", { text: ref, href: "#", cls: "oawm-changes-baseref-item" });
          item.onclick = async (e) => {
            e.preventDefault();
            await this.deps.setBaseRef(target.repoPath, ref);
            this.baseRefEditing = false;
            await this.render();
          };
        }
      }, 200);
    };
    input.focus();
  }

  private tabButton(parent: HTMLElement, id: "local" | "diff", label: string) {
    const btn = parent.createEl("button", { text: label, cls: this.tab === id ? "oawm-tab-active" : "" });
    btn.onclick = () => { this.tab = id; void this.render(); };
  }

  private renderLocal(body: HTMLElement, target: CheckoutTarget, files: FileChange[]) {
    if (files.length === 0) { body.createEl("em", { text: "No local changes" }); return; }
    for (const f of files) {
      const row = body.createDiv({ cls: "oawm-changes-filerow" });
      const cb = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = this.checked.has(f.path);
      cb.onchange = () => { cb.checked ? this.checked.add(f.path) : this.checked.delete(f.path); this.updateCommitButtons(); };
      row.createSpan({ cls: `oawm-badge-${f.kind}`, text: f.kind });
      const link = row.createEl("a", { text: ` ${f.path}`, href: "#" });
      link.onclick = (e) => { e.preventDefault(); void this.openFileDiff(target, f.path, "local"); };
      const pen = row.createEl("a", { text: " ✎", href: "#", cls: "oawm-pen" });
      pen.onclick = (e) => { e.preventDefault(); void this.deps.openEditor(target.path, f.path, target.session ?? null); };
    }
    const msg = body.createEl("textarea", { cls: "oawm-commit-msg", attr: { placeholder: "Commit message" } }) as HTMLTextAreaElement;
    msg.value = this.message;
    msg.oninput = () => { this.message = msg.value; this.updateCommitButtons(); };
    const btns = body.createDiv({ cls: "oawm-commit-btns" });
    this.commitPush = btns.createEl("button", { text: "Commit & Push" });
    this.commitOnly = btns.createEl("button", { text: "Commit" });
    this.commitPush.onclick = () => void this.doCommit(target, true);
    this.commitOnly.onclick = () => void this.doCommit(target, false);
    this.updateCommitButtons();
  }

  private commitPush?: HTMLButtonElement;
  private commitOnly?: HTMLButtonElement;
  private updateCommitButtons() {
    const enabled = commitEnabled(this.checked.size, this.message);
    if (this.commitPush) this.commitPush.disabled = !enabled;
    if (this.commitOnly) this.commitOnly.disabled = !enabled;
  }

  private async doCommit(target: CheckoutTarget, push: boolean) {
    await this.deps.commit.commitTarget(target, { paths: [...this.checked], message: this.message, push });
    this.checked.clear();
    this.message = "";
    await this.render();
  }

  private async renderDiff(body: HTMLElement, target: CheckoutTarget, files: FileChange[], baseRef: string) {
    if (files.length === 0) body.createEl("em", { text: `No changes vs ${baseRef}` });
    for (const f of files) {
      const row = body.createDiv({ cls: "oawm-changes-filerow" });
      row.createSpan({ cls: `oawm-badge-${f.kind}`, text: f.kind });
      const link = row.createEl("a", { text: ` ${f.path}`, href: "#" });
      link.onclick = (e) => { e.preventDefault(); void this.openFileDiff(target, f.path, "diff"); };
      const pen = row.createEl("a", { text: " ✎", href: "#", cls: "oawm-pen" });
      pen.onclick = (e) => { e.preventDefault(); void this.deps.openEditor(target.path, f.path, target.session ?? null); };
    }
    const btns = body.createDiv({ cls: "oawm-commit-btns" });
    if (target.kind === "worktree") {
      const task = target.taskPath ? await this.deps.vault.getTask(target.taskPath) : null;
      const merge = btns.createEl("button", { text: "Merge" });
      const mergePush = btns.createEl("button", { text: "Merge & Push" });
      const pr = btns.createEl("button", { text: "Open PR/MR" });
      merge.onclick = async () => { if (!task) return; await this.deps.completion.merge(task, { push: false }); await this.showTask(null); };
      mergePush.onclick = async () => { if (!task) return; await this.deps.completion.merge(task, { push: true }); await this.showTask(null); };
      pr.onclick = async () => { if (!task) return; const { url } = await this.deps.completion.openPr(task); if (url) this.deps.openExternal(url); };
      if (task && task.repositories.length > 1) {
        body.createEl("em", { cls: "oawm-changes-caveat", text: `Merge integrates the primary repo (${task.repositories[0]}) only.` });
      }
    } else {
      const push = btns.createEl("button", { text: "Push" });
      push.onclick = async () => { await this.deps.git.pushBase(target.path, target.branch); await this.render(); };
    }
  }

  private async openFileDiff(target: CheckoutTarget, path: string, scope: "local" | "diff") {
    const baseRef = resolveBaseRef(target, this.deps.pinnedBaseRefs());
    const diff = await this.deps.git.fileDiff(target.path, baseRef, path, scope === "local" ? "worktree" : "branch");
    await this.deps.openDiff(`${target.repo}/${path} (${scope === "local" ? "local" : baseRef})`, diff);
  }
}
```

- [ ] **Step 2: Add the `pinnedBaseRefs` setting**

In `src/main.ts`, add to the `OawmSettings` interface (after `editorCommand: string;`):

```ts
  pinnedBaseRefs: Record<string, string>;
```

and to `DEFAULT_SETTINGS` (after `editorCommand: "nvim +{line} {file}",`):

```ts
  pinnedBaseRefs: {},
```

- [ ] **Step 3: Update the `ChangesView` registration**

In `src/main.ts`, replace the `new ChangesView(leaf, { ... })` object (the block at ~lines 110-115) with:

```ts
      new ChangesView(leaf, {
        vault: this.vault, git: this.git, completion: this.completion, commit,
        pinnedBaseRefs: () => this.settings.pinnedBaseRefs,
        setBaseRef: async (repoPath, ref) => {
          if (ref) this.settings.pinnedBaseRefs[repoPath] = ref;
          else delete this.settings.pinnedBaseRefs[repoPath];
          await this.saveData(this.settings);
        },
        openDiff: (title, diff) => openDiffLeaf(this.app, this.settings.diffTarget, { title, diff }),
        openEditor: (dir, path, session) => this.openEditor(dir, path, session),
        openExternal: (url) => { const { shell } = require("electron"); shell.openExternal(url); },
      }));
```

- [ ] **Step 4: Change `openEditor` to take a directory + session**

In `src/main.ts`, replace the whole `private async openEditor(task: TaskNote, repo: string, path: string) { ... }` method (~lines 207-221) with:

```ts
  private async openEditor(dir: string, path: string, session: string | null) {
    if (!this.settings.editorCommand.trim()) { new Notice("OAWM: set an editor command in settings"); return; }
    const command = buildEditorCommand(this.settings.editorCommand, { file: join(dir, path) });
    if (this.settings.editorStrategy === "mux") {
      if (!session) { new Notice("OAWM: no terminal session for this checkout"); return; }
      await this.mux.openPane(session, dir, command);
    } else {
      const { spawn } = require("node:child_process");
      spawn("bash", ["-lc", command], { cwd: dir, detached: true, stdio: "ignore" }).unref();
    }
  }
```

Then remove the now-unused import on line 22 of `src/main.ts`:

```ts
import { resolveTaskWorktrees } from "./core/worktrees";
```

(Search the file to confirm no other reference to `resolveTaskWorktrees` remains; the only use was inside the old `openEditor`.)

- [ ] **Step 5: Typecheck, test, and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests green; `main.js` emitted.

- [ ] **Step 6: Append manual checks to `docs/MANUAL-TEST.md`**

Add this section to the end of `docs/MANUAL-TEST.md`:

```markdown
## Changes panel — per-repo checkout selector

1. Open the Changes panel with no task selected. Each workspace repo appears as a
   `▾ <repo>` group with a `◆ <baseBranch>` (main checkout) row plus one `○ <id> — <title>`
   row per task worktree, each showing `● <local> ↑ <vs-base>` counts. A repo with no
   tasks still shows its `◆` row.
2. Click a `◆ main` row → detail view opens with **Local** and **`vs origin/<base>`** tabs.
   Edit a file in the repo's main checkout → it shows under Local; check it, type a message,
   **Commit** (then **Commit & Push** → pushes the base branch via `git push origin <base>`).
3. In a base checkout's **`vs origin/<base>`** tab, the bottom action is **Push** (no
   Merge / Open PR). In a worktree checkout's diff tab, the actions are **Merge /
   Merge & Push / Open PR** as before.
4. Click the `vs <baseRef>` control → type ≥1 char → matching branches appear → pick one.
   The detail re-renders comparing against the picked ref, and `(use default)` appears.
   Click `(use default)` → reverts to the default ref.
5. Pin a base ref, then reload Obsidian (or toggle the panel) → the pin persists (stored in
   plugin data under `pinnedBaseRefs`, keyed by repo path).
6. From a task note's action bar, "View changes / Review" still deep-links into that task's
   primary-repo worktree detail.
```

- [ ] **Step 7: Commit**

```bash
git add src/obsidian/changesView.ts src/main.ts docs/MANUAL-TEST.md
git commit -m "feat(changes): per-repo checkout selector with searchable base ref"
```

---

## Task 6: Docs sync

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `docs/gotchas.md`
- Modify: `CHANGELOG.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update the ARCHITECTURE module map**

In `ARCHITECTURE.md`, under `## Module map (one line each)`:

Add after the `core/worktrees.ts` line:

```markdown
- `core/targets.ts` — `buildTargets`/`resolveBaseRef`: a `CheckoutTarget` per repo base checkout + task worktree, grouped by repo; the changes panel's selectable units.
```

Update the `core/commit.ts` line to:

```markdown
- `core/commit.ts` — `CommitCoordinator`: multi-repo task commit & push (`commit`) and single-checkout commit & push (`commitTarget`, routes push by base/worktree).
```

Update the `obsidian/changesView.ts` line to:

```markdown
- `obsidian/changesView.ts` — Changes panel: repo-grouped tree of checkout targets (main + worktrees), per-target Local/diff tabs, commit/diff/edit, changeable searchable base ref.
```

- [ ] **Step 2: Add gotchas**

In `docs/gotchas.md`, add a new entry:

```markdown
## Changes panel base-ref defaults differ by checkout kind

`buildTargets` (`src/core/targets.ts`) gives a base checkout (`kind: "base"`) a default
base ref of `origin/<baseBranch>` (so its diff/counts show *unpushed* commits), while a
task worktree (`kind: "worktree"`) defaults to the local `<baseBranch>` (work ahead of
base — the original task behavior). Both are overridable via the panel's `vs <baseRef>`
picker. The pin is stored in plugin settings (`pinnedBaseRefs`) keyed by **repo path**
(`CheckoutTarget.repoPath`), so it applies to every checkout of that repo — not by
worktree dir. Base checkouts are deduped across workspaces by repo path.
```

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, add an `## Unreleased` section directly above `## 0.0.21`:

```markdown
## Unreleased

- Changes panel: when no task is selected it now lists every workspace repo's main/base checkout alongside its task worktrees (master/detail tree); the main checkout is just another selectable option you can commit, push, and diff. Added a changeable, searchable "vs <base ref>" comparison that pins per repo.
```

- [ ] **Step 4: Verify docs build context (no code impact) and commit**

Run: `npm run typecheck`
Expected: clean (sanity — no code touched).

```bash
git add ARCHITECTURE.md docs/gotchas.md CHANGELOG.md
git commit -m "docs: per-repo checkout selector (architecture, gotchas, changelog)"
```

---

## Self-Review

**Spec coverage:**
- CheckoutTarget abstraction → Task 1. ✓
- Master/detail tree grouped by repo, main + worktrees → Task 5 (`renderOverview`). ✓
- All workspace repos via `listWorkspaces`, deduped by path → Task 2 + Task 1 dedup. ✓
- Per-kind default base ref (`origin/<base>` vs `<base>`) → Task 1. ✓
- Changeable + searchable base-ref picker, pinned per repo, persisted in settings → Task 3 (`searchBranches`) + Task 5 (control + `setBaseRef`/`pinnedBaseRefs`). ✓
- Commit/push routed by kind; diff actions by kind → Task 4 (`commitTarget`) + Task 5 (`renderDiff`). ✓
- New ports (`listWorkspaces`, `searchBranches`) + fakes → Tasks 2, 3. ✓
- Deep-link from action bar/dashboard preserved → Task 5 (`showTask` mapping). ✓
- Docs sync → Task 6 + MANUAL-TEST in Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code; test code is concrete.

**Type consistency:** `CheckoutTarget` fields (`repo`, `repoPath`, `path`, `branch`, `kind`, `defaultBaseRef`, `taskPath?`, `taskId?`, `taskTitle?`, `session?`) are used identically in `buildTargets`, `resolveBaseRef`, `commitTarget`, and the view. `searchBranches(repoPath, query, limit)` and `commitTarget(target, { paths, message, push })` signatures match across definition (Tasks 3, 4) and call sites (Task 5). `openEditor(dir, path, session)` matches between `ChangesViewDeps` and `main.ts`.

**Out-of-scope confirmed not implemented:** worktree-creation start-from picker, multi-repo merge, inline diff comments, native editing — none appear in tasks.
```

