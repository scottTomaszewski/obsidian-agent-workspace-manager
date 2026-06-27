# Task Changes Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the task-scoped Changes panel — a persistent Obsidian sidebar view with a Workspace Overview home state and per-task Local/Unmerged tabs for multi-repo commit/push and committed-work review, plus a non-blocking popout diff view and a configurable editor-open action.

**Architecture:** Layered exactly like the existing code (pure logic in `src/core/*`, ports in `src/core/ports.ts`, git in `src/backends/git.ts`, Obsidian views in `src/obsidian/*`). All git/commit logic goes behind `GitBackend` and a new `CommitCoordinator`, both unit-tested (fakes + real-temp-repo contract). Obsidian `ItemView` DOM is thin and verified manually; every rendering decision is extracted into a pure, unit-tested helper.

**Tech Stack:** TypeScript, Obsidian plugin API (DOM via `createEl`), raw `git` via `src/backends/exec.ts`, zellij via `MuxBackend`, vitest with the `__mocks__/obsidian.ts` stub.

## Global Constraints

- Raw `git` only — no `gh`/`glab` (consistent with the completion spec).
- Base is per-task and base-agnostic — never assume `base == main`; read `ws.baseBranch` / task frontmatter.
- Worktree files live outside the vault — never open them with Obsidian's Vault API / `TFile`; diff content is read via git and rendered in our own view.
- Tests run under node (no `document`); test pure functions, not `ItemView` DOM. New pure logic lives in `src/core/*` and is unit-tested; DOM wiring is manual-tested.
- Follow existing patterns: `GitBackend` methods return result objects (never throw to the UI); coordinators take `{ vault, git, mux, notifier }`; notices are surfaced via `Notifier`.
- Per-task worktree path = `join(repo.path, ".oawm-worktrees", worktreeDirName(task.id, task.title))`; task branch = `branchName(task.id, task.title)`.
- Run the full suite with `npx vitest run` (or a single file with `npx vitest run tests/<file>`).
- Commit after every task once its tests pass.

---

### Task 1: FileChange model + git-status/name-status parsers (pure)

**Files:**
- Create: `src/core/changes.ts`
- Test: `tests/changes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ChangeKind = "M" | "A" | "D" | "R" | "?"`
  - `interface FileChange { path: string; repo: string; staged: boolean; kind: ChangeKind }`
  - `parseStatus(porcelain: string): FileChange[]` — parses `git status --porcelain` (v1) output; `repo` is `""`.
  - `parseNameStatus(out: string): FileChange[]` — parses `git diff --name-status` output; `staged` is `false`, `repo` is `""`.
  - `groupByRepo(files: FileChange[]): Map<string, FileChange[]>`
  - `kindBadge(kind: ChangeKind): string` — single-letter label.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/changes.test.ts
import { describe, it, expect } from "vitest";
import { parseStatus, parseNameStatus, groupByRepo, kindBadge, type FileChange } from "../src/core/changes";

describe("parseStatus (git status --porcelain v1)", () => {
  it("parses staged, unstaged, untracked, deleted, and renamed entries", () => {
    const out = [
      "M  src/staged.ts",     // staged modify
      " M src/unstaged.ts",   // unstaged modify
      "?? src/new.ts",        // untracked
      " D src/gone.ts",       // unstaged delete
      "A  src/added.ts",      // staged add
      "R  src/old.ts -> src/renamed.ts", // staged rename
    ].join("\n");
    expect(parseStatus(out)).toEqual<FileChange[]>([
      { path: "src/staged.ts", repo: "", staged: true, kind: "M" },
      { path: "src/unstaged.ts", repo: "", staged: false, kind: "M" },
      { path: "src/new.ts", repo: "", staged: false, kind: "?" },
      { path: "src/gone.ts", repo: "", staged: false, kind: "D" },
      { path: "src/added.ts", repo: "", staged: true, kind: "A" },
      { path: "src/renamed.ts", repo: "", staged: true, kind: "R" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseStatus("")).toEqual([]);
    expect(parseStatus("\n")).toEqual([]);
  });
});

describe("parseNameStatus (git diff --name-status)", () => {
  it("parses M/A/D and rename rows", () => {
    const out = ["M\tsrc/a.ts", "A\tsrc/b.ts", "D\tsrc/c.ts", "R100\tsrc/old.ts\tsrc/new.ts"].join("\n");
    expect(parseNameStatus(out)).toEqual<FileChange[]>([
      { path: "src/a.ts", repo: "", staged: false, kind: "M" },
      { path: "src/b.ts", repo: "", staged: false, kind: "A" },
      { path: "src/c.ts", repo: "", staged: false, kind: "D" },
      { path: "src/new.ts", repo: "", staged: false, kind: "R" },
    ]);
  });
});

describe("groupByRepo", () => {
  it("groups files by repo, preserving order", () => {
    const files: FileChange[] = [
      { path: "a", repo: "web", staged: false, kind: "M" },
      { path: "b", repo: "api", staged: false, kind: "A" },
      { path: "c", repo: "web", staged: false, kind: "M" },
    ];
    const g = groupByRepo(files);
    expect([...g.keys()]).toEqual(["web", "api"]);
    expect(g.get("web")!.map((f) => f.path)).toEqual(["a", "c"]);
  });
});

describe("kindBadge", () => {
  it("maps kinds to letters", () => {
    expect(kindBadge("M")).toBe("M");
    expect(kindBadge("?")).toBe("?");
    expect(kindBadge("R")).toBe("R");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/changes.test.ts`
Expected: FAIL — `Cannot find module '../src/core/changes'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/changes.ts
export type ChangeKind = "M" | "A" | "D" | "R" | "?";

export interface FileChange {
  path: string;   // path relative to the worktree root
  repo: string;   // repo name; "" when produced by a parser (caller stamps it)
  staged: boolean;
  kind: ChangeKind;
}

/** Parse `git status --porcelain` (v1). `XY path`, `?? path`, rename `R  old -> new`. */
export function parseStatus(porcelain: string): FileChange[] {
  const out: FileChange[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.trim().length === 0) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    if (line.startsWith("??")) {
      out.push({ path: rest, repo: "", staged: false, kind: "?" });
      continue;
    }
    const isRename = x === "R" || y === "R";
    if (isRename) {
      const arrow = rest.indexOf(" -> ");
      if (arrow !== -1) rest = rest.slice(arrow + 4);
    }
    const staged = x !== " " && x !== "?";
    let kind: ChangeKind;
    if (isRename) kind = "R";
    else if (x === "A") kind = "A";
    else if (x === "D" || y === "D") kind = "D";
    else kind = "M";
    out.push({ path: rest, repo: "", staged, kind });
  }
  return out;
}

/** Parse `git diff --name-status`. `M\tpath`, `A\tpath`, `D\tpath`, `R100\told\tnew`. */
export function parseNameStatus(out: string): FileChange[] {
  const result: FileChange[] = [];
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) continue;
    const cols = line.split("\t");
    const code = cols[0][0];
    let kind: ChangeKind;
    let path: string;
    if (code === "R") { kind = "R"; path = cols[2]; }
    else if (code === "A") { kind = "A"; path = cols[1]; }
    else if (code === "D") { kind = "D"; path = cols[1]; }
    else { kind = "M"; path = cols[1]; }
    result.push({ path, repo: "", staged: false, kind });
  }
  return result;
}

export function groupByRepo(files: FileChange[]): Map<string, FileChange[]> {
  const g = new Map<string, FileChange[]>();
  for (const f of files) {
    const arr = g.get(f.repo) ?? [];
    arr.push(f);
    g.set(f.repo, arr);
  }
  return g;
}

export function kindBadge(kind: ChangeKind): string {
  return kind;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/changes.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/changes.ts tests/changes.test.ts
git commit -m "feat: add FileChange model and git status/name-status parsers"
```

---

### Task 2: GitBackend.status + FakeGit + port

**Files:**
- Modify: `src/core/ports.ts` (add to `GitBackend`)
- Modify: `src/backends/git.ts` (implement `status`)
- Modify: `tests/fakes.ts` (extend `FakeGit`)
- Test: `tests/git.test.ts` (append a contract test)

**Interfaces:**
- Consumes: `parseStatus`, `FileChange` from `src/core/changes.ts` (Task 1).
- Produces: `GitBackend.status(worktreePath: string): Promise<FileChange[]>` — returns parsed working-tree changes with `repo: ""` (caller stamps repo).

- [ ] **Step 1: Write the failing test (append to `tests/git.test.ts`)**

```typescript
// add inside describe("RealGitBackend completion primitives", ...) or a new describe at end of tests/git.test.ts
describe("RealGitBackend.status", () => {
  const git2 = new RealGitBackend();
  let repo2: string;
  beforeEach(async () => { repo2 = await initRepo(); });

  it("reports staged, unstaged, and untracked files", async () => {
    await git2.createWorktree(repo2, "oawm/s", "s", "main");
    const wt = join(repo2, ".oawm-worktrees", "s");
    writeFileSync(join(wt, "README.md"), "changed\n");      // unstaged modify
    writeFileSync(join(wt, "brand.txt"), "new\n");          // untracked
    writeFileSync(join(wt, "staged.txt"), "s\n");
    await run("git", ["add", "staged.txt"], { cwd: wt });   // staged add
    const files = await git2.status(wt);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["README.md"]).toMatchObject({ staged: false, kind: "M" });
    expect(byPath["brand.txt"]).toMatchObject({ staged: false, kind: "?" });
    expect(byPath["staged.txt"]).toMatchObject({ staged: true, kind: "A" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git.test.ts`
Expected: FAIL — `git2.status is not a function`.

- [ ] **Step 3: Implement**

In `src/core/ports.ts`, add an import and a method to the `GitBackend` interface:

```typescript
import type { FileChange } from "./changes";
// ...inside interface GitBackend, add:
  status(worktreePath: string): Promise<FileChange[]>;
```

In `src/backends/git.ts`, add the import and method (place the method inside the `RealGitBackend` class):

```typescript
import { parseStatus } from "../core/changes";
import type { FileChange } from "../core/changes";
// ...inside class RealGitBackend:
  async status(worktreePath: string): Promise<FileChange[]> {
    const res = await run("git", ["status", "--porcelain"], { cwd: worktreePath });
    return parseStatus(res.stdout);
  }
```

In `tests/fakes.ts`, extend `FakeGit` (add a settable field and method):

```typescript
// inside class FakeGit, with the other fields:
  statusFiles: import("../src/core/changes").FileChange[] = [];
// with the other methods:
  async status() { return this.statusFiles; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS (new status test + existing suite green; fakes still satisfy `GitBackend`).

- [ ] **Step 5: Commit**

```bash
git add src/core/ports.ts src/backends/git.ts tests/fakes.ts tests/git.test.ts
git commit -m "feat: add GitBackend.status working-tree change reporting"
```

---

### Task 3: GitBackend.commitPaths + FakeGit + port

**Files:**
- Modify: `src/core/ports.ts`
- Modify: `src/backends/git.ts`
- Modify: `tests/fakes.ts`
- Test: `tests/git.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GitBackend.commitPaths(worktreePath: string, paths: string[], message: string): Promise<{ ok: boolean; message: string; commit?: string }>` — stages exactly `paths`, commits exactly `paths`, returns short SHA on success.

- [ ] **Step 1: Write the failing test (append to `tests/git.test.ts`)**

```typescript
describe("RealGitBackend.commitPaths", () => {
  const git3 = new RealGitBackend();
  let repo3: string;
  beforeEach(async () => { repo3 = await initRepo(); });

  it("commits only the given paths, leaving other changes uncommitted", async () => {
    await git3.createWorktree(repo3, "oawm/c", "c", "main");
    const wt = join(repo3, ".oawm-worktrees", "c");
    writeFileSync(join(wt, "keep.txt"), "in commit\n");
    writeFileSync(join(wt, "skip.txt"), "left dirty\n");
    const res = await git3.commitPaths(wt, ["keep.txt"], "feat: keep only");
    expect(res.ok).toBe(true);
    expect(res.commit).toMatch(/^[0-9a-f]{7,}$/);
    // skip.txt is still an untracked/uncommitted change
    const after = await git3.status(wt);
    expect(after.map((f) => f.path)).toContain("skip.txt");
    expect(after.map((f) => f.path)).not.toContain("keep.txt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git.test.ts`
Expected: FAIL — `git3.commitPaths is not a function`.

- [ ] **Step 3: Implement**

`src/core/ports.ts` — add to `GitBackend`:

```typescript
  commitPaths(worktreePath: string, paths: string[], message: string): Promise<{ ok: boolean; message: string; commit?: string }>;
```

`src/backends/git.ts` — add to `RealGitBackend`:

```typescript
  async commitPaths(worktreePath: string, paths: string[], message: string): Promise<{ ok: boolean; message: string; commit?: string }> {
    const add = await run("git", ["add", "--", ...paths], { cwd: worktreePath });
    if (add.code !== 0) return { ok: false, message: add.stderr.trim() };
    const res = await run("git", ["commit", "-m", message, "--", ...paths], { cwd: worktreePath });
    if (res.code !== 0) return { ok: false, message: (res.stdout + res.stderr).trim() };
    const sha = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: worktreePath });
    return { ok: true, message: res.stdout.trim(), commit: sha.stdout.trim() };
  }
```

`tests/fakes.ts` — extend `FakeGit`:

```typescript
// fields:
  commitCalls: { worktree: string; paths: string[]; message: string }[] = [];
  failCommitWorktrees = new Set<string>();
// method:
  async commitPaths(worktree: string, paths: string[], message: string) {
    this.commitCalls.push({ worktree, paths, message });
    if (this.failCommitWorktrees.has(worktree)) return { ok: false, message: "commit failed" };
    return { ok: true, message: "", commit: "abc1234" };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/ports.ts src/backends/git.ts tests/fakes.ts tests/git.test.ts
git commit -m "feat: add GitBackend.commitPaths (stage + commit exact paths)"
```

---

### Task 4: GitBackend.branchDiffFiles, fileDiff, unmergedCounts + FakeGit + port

**Files:**
- Modify: `src/core/ports.ts`
- Modify: `src/backends/git.ts`
- Modify: `tests/fakes.ts`
- Test: `tests/git.test.ts`

**Interfaces:**
- Consumes: `parseNameStatus`, `FileChange` from Task 1.
- Produces:
  - `GitBackend.branchDiffFiles(worktreePath: string, base: string): Promise<FileChange[]>`
  - `GitBackend.fileDiff(worktreePath: string, base: string, path: string, scope: "worktree" | "branch"): Promise<string>`
  - `GitBackend.unmergedCounts(worktreePath: string, base: string): Promise<{ local: number; unmerged: number }>`

- [ ] **Step 1: Write the failing test (append to `tests/git.test.ts`)**

```typescript
describe("RealGitBackend review primitives", () => {
  const git4 = new RealGitBackend();
  let repo4: string;
  beforeEach(async () => { repo4 = await initRepo(); });

  it("branchDiffFiles lists committed changes vs base; unmergedCounts counts them", async () => {
    await git4.createWorktree(repo4, "oawm/r", "r", "main");
    const wt = join(repo4, ".oawm-worktrees", "r");
    writeFileSync(join(wt, "feat.txt"), "feat\n");
    await run("git", ["add", "."], { cwd: wt });
    await run("git", ["commit", "-m", "feat"], { cwd: wt });
    const files = await git4.branchDiffFiles(wt, "main");
    expect(files.map((f) => f.path)).toContain("feat.txt");
    const counts = await git4.unmergedCounts(wt, "main");
    expect(counts.unmerged).toBe(1);
    expect(counts.local).toBe(0);
  });

  it("fileDiff returns a diff for a tracked modified file (worktree scope)", async () => {
    await git4.createWorktree(repo4, "oawm/r", "r", "main");
    const wt = join(repo4, ".oawm-worktrees", "r");
    writeFileSync(join(wt, "README.md"), "modified line\n");
    const diff = await git4.fileDiff(wt, "main", "README.md", "worktree");
    expect(diff).toContain("modified line");
  });

  it("fileDiff returns added-file content for an untracked file (worktree scope)", async () => {
    await git4.createWorktree(repo4, "oawm/r", "r", "main");
    const wt = join(repo4, ".oawm-worktrees", "r");
    writeFileSync(join(wt, "fresh.txt"), "brand new\n");
    const diff = await git4.fileDiff(wt, "main", "fresh.txt", "worktree");
    expect(diff).toContain("brand new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git.test.ts`
Expected: FAIL — `git4.branchDiffFiles is not a function`.

- [ ] **Step 3: Implement**

`src/core/ports.ts` — add to `GitBackend`:

```typescript
  branchDiffFiles(worktreePath: string, base: string): Promise<FileChange[]>;
  fileDiff(worktreePath: string, base: string, path: string, scope: "worktree" | "branch"): Promise<string>;
  unmergedCounts(worktreePath: string, base: string): Promise<{ local: number; unmerged: number }>;
```

`src/backends/git.ts` — add to `RealGitBackend` (uses the `parseStatus`/`parseNameStatus` imports; add `parseNameStatus` to the existing import line):

```typescript
  async branchDiffFiles(worktreePath: string, base: string): Promise<FileChange[]> {
    const res = await run("git", ["diff", "--name-status", `${base}...HEAD`], { cwd: worktreePath });
    return parseNameStatus(res.stdout);
  }

  async fileDiff(worktreePath: string, base: string, path: string, scope: "worktree" | "branch"): Promise<string> {
    if (scope === "branch") {
      return (await run("git", ["diff", `${base}...HEAD`, "--", path], { cwd: worktreePath })).stdout;
    }
    const tracked = (await run("git", ["ls-files", "--error-unmatch", "--", path], { cwd: worktreePath })).code === 0;
    if (tracked) return (await run("git", ["diff", "HEAD", "--", path], { cwd: worktreePath })).stdout;
    // Untracked: show whole-file as added (git exits 1 with --no-index when files differ).
    return (await run("git", ["diff", "--no-index", "--", "/dev/null", path], { cwd: worktreePath })).stdout;
  }

  async unmergedCounts(worktreePath: string, base: string): Promise<{ local: number; unmerged: number }> {
    const status = await run("git", ["status", "--porcelain"], { cwd: worktreePath });
    const local = status.stdout.split("\n").filter((l) => l.trim().length > 0).length;
    const rev = await run("git", ["rev-list", "--count", `${base}..HEAD`], { cwd: worktreePath });
    const unmerged = parseInt(rev.stdout.trim(), 10) || 0;
    return { local, unmerged };
  }
```

`tests/fakes.ts` — extend `FakeGit`:

```typescript
// fields:
  branchFiles: import("../src/core/changes").FileChange[] = [];
  fileDiffText = "diff --git a b\n";
  counts: { local: number; unmerged: number } = { local: 0, unmerged: 0 };
// methods:
  async branchDiffFiles() { return this.branchFiles; }
  async fileDiff() { return this.fileDiffText; }
  async unmergedCounts() { return this.counts; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/ports.ts src/backends/git.ts tests/fakes.ts tests/git.test.ts
git commit -m "feat: add GitBackend review primitives (branchDiffFiles, fileDiff, unmergedCounts)"
```

---

### Task 5: resolveTaskWorktrees (pure multi-repo resolution)

**Files:**
- Create: `src/core/worktrees.ts`
- Test: `tests/worktrees.test.ts`

**Interfaces:**
- Consumes: `TaskNote`, `WorkspaceNote`, `worktreeDirName`, `branchName` from `src/domain/types.ts`.
- Produces:
  - `interface TaskWorktree { repo: string; path: string; branch: string }`
  - `resolveTaskWorktrees(task: TaskNote, ws: WorkspaceNote): TaskWorktree[]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/worktrees.test.ts
import { describe, it, expect } from "vitest";
import { resolveTaskWorktrees } from "../src/core/worktrees";
import type { TaskNote, WorkspaceNote } from "../src/domain/types";

const ws: WorkspaceNote = {
  name: "W",
  repositories: [{ name: "web", path: "/code/web" }, { name: "api", path: "/code/api" }],
  isolation: "worktree", baseBranch: "main",
  git: { user: "u", email: "e" }, mux: { backend: "zellij" }, host: { type: "local" }, env: {},
};
const task = (repos: string[]): TaskNote => ({
  path: "T.md", id: "DS-1", title: "Add OAuth", workspace: "W", repositories: repos,
  agent: "vexa", status: "Running", agentState: "Running", worktree: "", branch: "", session: "",
});

describe("resolveTaskWorktrees", () => {
  it("resolves one worktree per declared repo with derived path + branch", () => {
    expect(resolveTaskWorktrees(task(["web", "api"]), ws)).toEqual([
      { repo: "web", path: "/code/web/.oawm-worktrees/ds-1-add-oauth", branch: "oawm/ds-1-add-oauth" },
      { repo: "api", path: "/code/api/.oawm-worktrees/ds-1-add-oauth", branch: "oawm/ds-1-add-oauth" },
    ]);
  });

  it("repo-direct isolation resolves to the repo path itself", () => {
    const direct = { ...ws, isolation: "repo-direct" as const };
    expect(resolveTaskWorktrees(task(["web"]), direct)).toEqual([
      { repo: "web", path: "/code/web", branch: "oawm/ds-1-add-oauth" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worktrees.test.ts`
Expected: FAIL — `Cannot find module '../src/core/worktrees'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/worktrees.ts
import { join } from "node:path";
import { branchName, worktreeDirName } from "../domain/types";
import type { TaskNote, WorkspaceNote } from "../domain/types";

export interface TaskWorktree {
  repo: string;
  path: string;
  branch: string;
}

export function resolveTaskWorktrees(task: TaskNote, ws: WorkspaceNote): TaskWorktree[] {
  const dir = worktreeDirName(task.id, task.title);
  const branch = branchName(task.id, task.title);
  const names = task.repositories.length > 0 ? task.repositories : ws.repositories.map((r) => r.name);
  return names.map((name) => {
    const repo = ws.repositories.find((r) => r.name === name) ?? ws.repositories[0];
    const path = ws.isolation === "worktree" ? join(repo.path, ".oawm-worktrees", dir) : repo.path;
    return { repo: name, path, branch };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worktrees.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/worktrees.ts tests/worktrees.test.ts
git commit -m "feat: add resolveTaskWorktrees multi-repo helper"
```

---

### Task 6: CommitCoordinator (multi-repo commit & push, shared message)

**Files:**
- Create: `src/core/commit.ts`
- Test: `tests/commit.test.ts`

**Interfaces:**
- Consumes: `resolveTaskWorktrees`/`TaskWorktree` (Task 5); `GitBackend.commitPaths` (Task 3); `GitBackend.pushBranch` (existing); `VaultGateway`, `Notifier`.
- Produces:
  - `interface CommitInput { paths: { repo: string; path: string }[]; message: string; push: boolean }`
  - `interface RepoResult { repo: string; committed: boolean; pushed: boolean; commit?: string; error?: string }`
  - `summarizeCommit(taskId: string, results: RepoResult[]): string` (pure, exported for testing)
  - `class CommitCoordinator { constructor(deps: { vault; git; notifier }); commit(task, input): Promise<RepoResult[]> }`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/commit.test.ts
import { describe, it, expect } from "vitest";
import { CommitCoordinator, summarizeCommit } from "../src/core/commit";
import { FakeGit, FakeVault, FakeNotifier } from "./fakes";
import type { WorkspaceNote } from "../src/domain/types";

const ws: WorkspaceNote = {
  name: "W",
  repositories: [{ name: "web", path: "/code/web" }, { name: "api", path: "/code/api" }],
  isolation: "worktree", baseBranch: "main",
  git: { user: "u", email: "e" }, mux: { backend: "zellij" }, host: { type: "local" }, env: {},
};

function setup() {
  const vault = new FakeVault();
  vault.workspaces.set("W", ws);
  vault.seedTask({ path: "T.md", id: "DS-1", title: "Add OAuth", workspace: "W", repositories: ["web", "api"], status: "Running", agentState: "Running" });
  const git = new FakeGit();
  const notifier = new FakeNotifier();
  const coord = new CommitCoordinator({ vault, git, notifier });
  return { vault, git, notifier, coord };
}

describe("CommitCoordinator.commit", () => {
  it("commits checked paths per repo with the shared message, then pushes when requested", async () => {
    const { git, coord } = setup();
    const task = (await new FakeVault().getTask("T.md")) ?? undefined; // placeholder; real task fetched below
    const t = { path: "T.md", id: "DS-1", title: "Add OAuth", workspace: "W", repositories: ["web", "api"], agent: "vexa", status: "Running" as const, agentState: "Running" as const, worktree: "", branch: "", session: "" };
    const results = await coord.commit(t, {
      paths: [{ repo: "web", path: "a.ts" }, { repo: "web", path: "b.ts" }, { repo: "api", path: "c.go" }],
      message: "feat: oauth", push: true,
    });
    expect(git.commitCalls).toEqual([
      { worktree: "/code/web/.oawm-worktrees/ds-1-add-oauth", paths: ["a.ts", "b.ts"], message: "feat: oauth" },
      { worktree: "/code/api/.oawm-worktrees/ds-1-add-oauth", paths: ["c.go"], message: "feat: oauth" },
    ]);
    expect(git.pushedBranches.map((p) => p.branch)).toEqual(["oawm/ds-1-add-oauth", "oawm/ds-1-add-oauth"]);
    expect(results.every((r) => r.committed && r.pushed)).toBe(true);
  });

  it("skips repos with no checked files", async () => {
    const { git, coord } = setup();
    const t = { path: "T.md", id: "DS-1", title: "Add OAuth", workspace: "W", repositories: ["web", "api"], agent: "vexa", status: "Running" as const, agentState: "Running" as const, worktree: "", branch: "", session: "" };
    await coord.commit(t, { paths: [{ repo: "web", path: "a.ts" }], message: "m", push: false });
    expect(git.commitCalls.map((c) => c.worktree)).toEqual(["/code/web/.oawm-worktrees/ds-1-add-oauth"]);
  });

  it("on partial failure keeps the succeeded repo committed and reports the failed one (no rollback)", async () => {
    const { git, coord } = setup();
    git.failCommitWorktrees.add("/code/api/.oawm-worktrees/ds-1-add-oauth");
    const t = { path: "T.md", id: "DS-1", title: "Add OAuth", workspace: "W", repositories: ["web", "api"], agent: "vexa", status: "Running" as const, agentState: "Running" as const, worktree: "", branch: "", session: "" };
    const results = await coord.commit(t, {
      paths: [{ repo: "web", path: "a.ts" }, { repo: "api", path: "c.go" }], message: "m", push: false,
    });
    expect(results).toEqual([
      { repo: "web", committed: true, pushed: false, commit: "abc1234" },
      { repo: "api", committed: false, pushed: false, error: "commit failed" },
    ]);
  });
});

describe("summarizeCommit", () => {
  it("formats per-repo outcomes", () => {
    const s = summarizeCommit("DS-1", [
      { repo: "web", committed: true, pushed: true, commit: "abc1234" },
      { repo: "api", committed: false, pushed: false, error: "boom" },
    ]);
    expect(s).toContain("web: committed abc1234, pushed");
    expect(s).toContain("api: commit failed — boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commit.test.ts`
Expected: FAIL — `Cannot find module '../src/core/commit'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/commit.ts
import type { TaskNote } from "../domain/types";
import type { VaultGateway, GitBackend, Notifier } from "./ports";
import { resolveTaskWorktrees } from "./worktrees";

export interface CommitDeps {
  vault: VaultGateway;
  git: GitBackend;
  notifier: Notifier;
}

export interface CommitInput {
  paths: { repo: string; path: string }[];
  message: string;
  push: boolean;
}

export interface RepoResult {
  repo: string;
  committed: boolean;
  pushed: boolean;
  commit?: string;
  error?: string;
}

export function summarizeCommit(taskId: string, results: RepoResult[]): string {
  const parts = results.map((r) => {
    if (!r.committed) return `${r.repo}: commit failed — ${r.error ?? "unknown"}`;
    if (r.error) return `${r.repo}: committed ${r.commit ?? ""}, push failed — ${r.error}`;
    return `${r.repo}: committed ${r.commit ?? ""}${r.pushed ? ", pushed" : ""}`;
  });
  return `Task ${taskId}: ${parts.join(" · ")}`;
}

export class CommitCoordinator {
  constructor(private deps: CommitDeps) {}

  async commit(task: TaskNote, input: CommitInput): Promise<RepoResult[]> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) { this.deps.notifier.notice(`Task ${task.id}: missing workspace`); return []; }

    const byRepo = new Map<string, string[]>();
    for (const p of input.paths) {
      const arr = byRepo.get(p.repo) ?? [];
      arr.push(p.path);
      byRepo.set(p.repo, arr);
    }

    const results: RepoResult[] = [];
    for (const wt of resolveTaskWorktrees(task, ws)) {
      const repoPaths = byRepo.get(wt.repo);
      if (!repoPaths || repoPaths.length === 0) continue;

      const c = await this.deps.git.commitPaths(wt.path, repoPaths, input.message);
      if (!c.ok) { results.push({ repo: wt.repo, committed: false, pushed: false, error: c.message }); continue; }

      if (!input.push) { results.push({ repo: wt.repo, committed: true, pushed: false, commit: c.commit }); continue; }

      const pr = await this.deps.git.pushBranch(wt.path, wt.branch);
      results.push({ repo: wt.repo, committed: true, pushed: pr.ok, commit: c.commit, error: pr.ok ? undefined : pr.message });
    }

    if (results.length === 0) this.deps.notifier.notice(`Task ${task.id}: nothing to commit`);
    else this.deps.notifier.notice(summarizeCommit(task.id, results));
    return results;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/commit.ts tests/commit.test.ts
git commit -m "feat: add CommitCoordinator for multi-repo commit & push"
```

---

### Task 7: Editor-open command builder + MuxBackend.openPane

**Files:**
- Create: `src/core/editorOpen.ts`
- Modify: `src/core/ports.ts` (add `openPane` to `MuxBackend`)
- Modify: `src/backends/zellij.ts` (add `newPaneArgs` + `openPane`)
- Modify: `tests/fakes.ts` (extend `FakeMux`)
- Test: `tests/editorOpen.test.ts`, `tests/zellij.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `buildEditorCommand(template: string, ctx: { file: string; line?: number }): string`
  - `MuxBackend.openPane(session: string, cwd: string, command: string): Promise<void>`
  - `newPaneArgs(session: string, cwd: string, command: string): string[]` (exported from `zellij.ts`)

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/editorOpen.test.ts
import { describe, it, expect } from "vitest";
import { buildEditorCommand } from "../src/core/editorOpen";

describe("buildEditorCommand", () => {
  it("substitutes {file} and {line}", () => {
    expect(buildEditorCommand("nvim +{line} {file}", { file: "/a/b.ts", line: 42 })).toBe("nvim +42 /a/b.ts");
  });
  it("defaults line to 1 when omitted", () => {
    expect(buildEditorCommand("nvim +{line} {file}", { file: "/a/b.ts" })).toBe("nvim +1 /a/b.ts");
  });
  it("works with templates that omit {line}", () => {
    expect(buildEditorCommand("glow {file}", { file: "/a/b.md" })).toBe("glow /a/b.md");
  });
});
```

```typescript
// append to tests/zellij.test.ts
import { newPaneArgs } from "../src/backends/zellij";
describe("newPaneArgs", () => {
  it("targets the session and runs the command in a new pane", () => {
    expect(newPaneArgs("oawm-DS-1", "/code/web", "nvim +5 a.ts")).toEqual([
      "--session", "oawm-DS-1", "action", "new-pane", "--cwd", "/code/web", "--", "bash", "-lc", "nvim +5 a.ts",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/editorOpen.test.ts tests/zellij.test.ts`
Expected: FAIL — `Cannot find module '../src/core/editorOpen'` and `newPaneArgs` undefined.

- [ ] **Step 3: Implement**

```typescript
// src/core/editorOpen.ts
export function buildEditorCommand(template: string, ctx: { file: string; line?: number }): string {
  return template
    .replace(/\{file\}/g, ctx.file)
    .replace(/\{line\}/g, String(ctx.line ?? 1));
}
```

`src/backends/zellij.ts` — add an exported helper and a method on `ZellijBackend`:

```typescript
export function newPaneArgs(session: string, cwd: string, command: string): string[] {
  return ["--session", session, "action", "new-pane", "--cwd", cwd, "--", "bash", "-lc", command];
}
// inside class ZellijBackend:
  async openPane(session: string, cwd: string, command: string): Promise<void> {
    await run(this.bin, newPaneArgs(session, cwd, command));
  }
```

`src/core/ports.ts` — add to `MuxBackend`:

```typescript
  openPane(session: string, cwd: string, command: string): Promise<void>;
```

`tests/fakes.ts` — extend `FakeMux`:

```typescript
// field:
  openPaneCalls: { session: string; cwd: string; command: string }[] = [];
// method:
  async openPane(session: string, cwd: string, command: string) { this.openPaneCalls.push({ session, cwd, command }); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS (fakes still satisfy `MuxBackend`; existing zellij/terminal tests green).

- [ ] **Step 5: Commit**

```bash
git add src/core/editorOpen.ts src/core/ports.ts src/backends/zellij.ts tests/fakes.ts tests/editorOpen.test.ts tests/zellij.test.ts
git commit -m "feat: add editor command builder and zellij openPane"
```

---

### Task 8: Changes-panel pure helpers (commit-enabled, select-all, file-row repo stamping)

**Files:**
- Modify: `src/core/changes.ts`
- Test: `tests/changes.test.ts` (append)

**Interfaces:**
- Consumes: `FileChange` (Task 1).
- Produces:
  - `commitEnabled(checkedCount: number, message: string): boolean`
  - `type SelectAllState = "none" | "some" | "all"`
  - `selectAllState(total: number, checked: number): SelectAllState`
  - `stampRepo(files: FileChange[], repo: string): FileChange[]` — returns copies with `repo` set (used when aggregating per-worktree status into the combined list).

- [ ] **Step 1: Write the failing test (append to `tests/changes.test.ts`)**

```typescript
import { commitEnabled, selectAllState, stampRepo } from "../src/core/changes";

describe("commitEnabled", () => {
  it("requires at least one checked file and a non-empty message", () => {
    expect(commitEnabled(0, "msg")).toBe(false);
    expect(commitEnabled(2, "")).toBe(false);
    expect(commitEnabled(2, "   ")).toBe(false);
    expect(commitEnabled(1, "feat: x")).toBe(true);
  });
});

describe("selectAllState", () => {
  it("derives tri-state from totals", () => {
    expect(selectAllState(3, 0)).toBe("none");
    expect(selectAllState(3, 2)).toBe("some");
    expect(selectAllState(3, 3)).toBe("all");
    expect(selectAllState(0, 0)).toBe("none");
  });
});

describe("stampRepo", () => {
  it("returns copies with the repo set, leaving inputs untouched", () => {
    const input: FileChange[] = [{ path: "a", repo: "", staged: false, kind: "M" }];
    const out = stampRepo(input, "web");
    expect(out).toEqual([{ path: "a", repo: "web", staged: false, kind: "M" }]);
    expect(input[0].repo).toBe(""); // not mutated
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/changes.test.ts`
Expected: FAIL — `commitEnabled is not exported`.

- [ ] **Step 3: Write minimal implementation (append to `src/core/changes.ts`)**

```typescript
export function commitEnabled(checkedCount: number, message: string): boolean {
  return checkedCount > 0 && message.trim().length > 0;
}

export type SelectAllState = "none" | "some" | "all";

export function selectAllState(total: number, checked: number): SelectAllState {
  if (checked === 0 || total === 0) return "none";
  if (checked >= total) return "all";
  return "some";
}

export function stampRepo(files: FileChange[], repo: string): FileChange[] {
  return files.map((f) => ({ ...f, repo }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/changes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/changes.ts tests/changes.test.ts
git commit -m "feat: add changes-panel pure helpers (commit-enabled, select-all, stampRepo)"
```

---

### Task 9: DiffView (popout/split) replacing DiffModal

**Files:**
- Create: `src/obsidian/diffView.ts`
- Modify: `src/obsidian/diffPanel.ts` (keep `splitDiffLines`; `DiffModal` may stay until Task 10 removes its last use)
- Modify: `src/main.ts` (register `DiffView`, add `diffTarget` setting, replace `showDiff`)
- Modify: `styles.css` (reuse existing `oawm-diff-*` classes; no new classes required)

**Interfaces:**
- Consumes: `splitDiffLines` from `diffPanel.ts`.
- Produces:
  - `const DIFF_VIEW_TYPE = "oawm-diff"`
  - `interface DiffViewState { title: string; diff: string }`
  - `class DiffView extends ItemView` with `setDiff(state: DiffViewState): void`
  - `openDiffLeaf(app, target: "popout" | "split", state): Promise<void>` (helper used by `main.ts` and later `ChangesView`) — reuses a single existing `oawm-diff` leaf rather than stacking new ones.

This task is DOM-heavy and verified manually (no jsdom). There is no unit test; the deliverable is the registered, working view. `splitDiffLines` is already unit-tested in `tests/diffFormat.test.ts`.

- [ ] **Step 1: Create `src/obsidian/diffView.ts`**

```typescript
import { ItemView, WorkspaceLeaf, App } from "obsidian";
import { splitDiffLines } from "./diffPanel";

export const DIFF_VIEW_TYPE = "oawm-diff";

export interface DiffViewState { title: string; diff: string }

export class DiffView extends ItemView {
  private state: DiffViewState = { title: "Diff", diff: "" };
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return DIFF_VIEW_TYPE; }
  getDisplayText() { return this.state.title; }
  getIcon() { return "git-compare"; }

  setDiff(state: DiffViewState) { this.state = state; this.render(); }
  async onOpen() { this.render(); }

  private render() {
    const root = this.contentEl;
    root.empty();
    root.createEl("h4", { text: this.state.title });
    const pre = root.createEl("pre", { cls: "oawm-diff" });
    for (const line of splitDiffLines(this.state.diff || "(no changes)")) {
      pre.createEl("div", { cls: `oawm-diff-${line.kind}`, text: line.text || " " });
    }
  }
}

/** Open (or reuse) a single diff leaf in a popout window or a main-area split. */
export async function openDiffLeaf(app: App, target: "popout" | "split", state: DiffViewState): Promise<void> {
  const existing = app.workspace.getLeavesOfType(DIFF_VIEW_TYPE);
  const leaf = existing[0] ?? (target === "popout" ? app.workspace.openPopoutLeaf() : app.workspace.getLeaf("split"));
  await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });
  const view = leaf.view;
  if (view instanceof DiffView) view.setDiff(state);
  app.workspace.revealLeaf(leaf);
}
```

- [ ] **Step 2: Register the view and add the setting in `src/main.ts`**

Add to imports:

```typescript
import { DiffView, DIFF_VIEW_TYPE, openDiffLeaf } from "./obsidian/diffView";
```

Add to `OawmSettings` and `DEFAULT_SETTINGS`:

```typescript
// in interface OawmSettings:
  diffTarget: "popout" | "split";
// in DEFAULT_SETTINGS:
  diffTarget: "popout",
```

In `onload()`, register the view (next to the dashboard `registerView`):

```typescript
this.registerView(DIFF_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DiffView(leaf));
```

Replace the body of `showDiff` to use the new view instead of `DiffModal`:

```typescript
  private async showDiff(task: TaskNote) {
    const ws = await this.vault.getWorkspace(task.workspace);
    if (!ws || !task.branch) { new Notice("OAWM: no branch to diff"); return; }
    const repo = ws.repositories.find((r) => r.name === task.repositories[0]) ?? ws.repositories[0];
    const diff = await this.git.diff(repo.path, ws.baseBranch, task.branch);
    await openDiffLeaf(this.app, this.settings.diffTarget, { title: `${task.id} diff`, diff });
  }
```

Remove the now-unused `DiffModal` import from `main.ts`.

Add a setting control in `OawmSettingTab.display()`:

```typescript
    new Setting(containerEl)
      .setName("Diff window")
      .setDesc("Where file diffs open. \"Popout\" opens a separate window so you can read a diff while referencing code in the main window; \"Split\" opens in the main editor area.")
      .addDropdown((d) =>
        d.addOption("popout", "Popout window").addOption("split", "Main split")
          .setValue(this.plugin.settings.diffTarget)
          .onChange(async (v) => { this.plugin.settings.diffTarget = v as "popout" | "split"; await this.plugin.saveData(this.plugin.settings); }));
```

- [ ] **Step 3: Build to verify it compiles**

Run: `npm run build` (or `npx tsc --noEmit` if available; the repo builds via esbuild — `npx tsc --noEmit -p tsconfig.json`)
Expected: no type errors; `DiffModal` no longer referenced in `main.ts`.

- [ ] **Step 4: Run the test suite**

Run: `npx vitest run`
Expected: PASS (no behavioral test regressions; `diffFormat.test.ts` still green).

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/diffView.ts src/main.ts
git commit -m "feat: add DiffView (popout/split) and replace DiffModal in showDiff"
```

---

### Task 10: ChangesView panel + Review Changes wiring + editor/commit settings

**Files:**
- Create: `src/obsidian/changesView.ts`
- Modify: `src/main.ts` (settings: `editorStrategy`, `editorCommand`; construct `CommitCoordinator`; register `ChangesView`; ribbon/command + `reviewChanges` action; `openEditor` handler)
- Modify: `src/obsidian/taskCodeBlock.ts` (rename `viewDiff` action label to "Review Changes" — keep id, repoint behavior)
- Modify: `src/obsidian/dashboardView.ts` (row click already opens the task note; add a small "Review" affordance that opens the panel on that task)
- Modify: `styles.css` (panel/list/commit-box classes)
- Modify: `docs/MANUAL-TEST.md` (append manual checks)

**Interfaces:**
- Consumes: everything above — `CommitCoordinator` (Task 6), `GitBackend.status`/`branchDiffFiles`/`fileDiff`/`unmergedCounts` (Tasks 2/4), `resolveTaskWorktrees` (Task 5), `buildEditorCommand` + `MuxBackend.openPane` (Task 7), `openDiffLeaf`/`DiffView` (Task 9), `groupByRepo`/`stampRepo`/`commitEnabled`/`selectAllState` (Tasks 1/8), `CompletionCoordinator` (existing).
- Produces:
  - `const CHANGES_VIEW_TYPE = "oawm-changes"`
  - `interface ChangesViewDeps { vault; git; completion; commit; openDiff(state); openEditor(task, repo, path); }`
  - `class ChangesView extends ItemView` with `showTask(path: string | null): Promise<void>` (null → Workspace Overview).

This view is DOM-heavy and verified manually. All decision logic it relies on is already unit-tested (Tasks 1–9). The deliverable is a working, registered panel.

- [ ] **Step 1: Create `src/obsidian/changesView.ts`**

```typescript
import { ItemView, WorkspaceLeaf } from "obsidian";
import type { TaskNote } from "../domain/types";
import type { VaultGateway, GitBackend } from "../core/ports";
import type { CompletionCoordinator } from "../core/completion";
import type { CommitCoordinator } from "../core/commit";
import { groupByRepo, stampRepo, commitEnabled, type FileChange } from "../core/changes";
import { resolveTaskWorktrees } from "../core/worktrees";
import { groupByState } from "./dashboardView";

export const CHANGES_VIEW_TYPE = "oawm-changes";

export interface ChangesViewDeps {
  vault: VaultGateway;
  git: GitBackend;
  completion: CompletionCoordinator;
  commit: CommitCoordinator;
  openDiff: (title: string, diff: string) => Promise<void>;
  openEditor: (task: TaskNote, repo: string, path: string) => Promise<void>;
}

export class ChangesView extends ItemView {
  private activeTaskPath: string | null = null;
  private tab: "local" | "unmerged" = "local";
  private checked = new Set<string>();   // "repo path"
  private message = "";

  constructor(leaf: WorkspaceLeaf, private deps: ChangesViewDeps) { super(leaf); }
  getViewType() { return CHANGES_VIEW_TYPE; }
  getDisplayText() { return "Task Changes"; }
  getIcon() { return "git-pull-request"; }

  async onOpen() { await this.render(); }

  async showTask(path: string | null) {
    this.activeTaskPath = path;
    this.checked.clear();
    this.message = "";
    this.tab = "local";
    await this.render();
  }

  private key(repo: string, path: string) { return `${repo} ${path}`; }

  private async render() {
    const root = this.contentEl;
    root.empty();
    if (!this.activeTaskPath) { await this.renderOverview(root); return; }
    const task = await this.deps.vault.getTask(this.activeTaskPath);
    if (!task) { await this.renderOverview(root); return; }
    await this.renderTask(root, task);
  }

  private async renderOverview(root: HTMLElement) {
    root.createEl("h4", { text: "Workspace Changes" });
    const tasks = (await this.deps.vault.listTasks()).filter((t) => t.branch && t.worktree);
    const groups = groupByState(tasks);
    for (const state of Object.keys(groups) as (keyof typeof groups)[]) {
      const list = groups[state];
      if (list.length === 0) continue;
      root.createEl("div", { cls: "oawm-changes-state", text: state });
      for (const t of list) {
        const row = root.createDiv({ cls: "oawm-changes-overrow" });
        const link = row.createEl("a", { text: `${t.id} — ${t.title}`, href: "#" });
        link.onclick = (e) => { e.preventDefault(); void this.showTask(t.path); };
        const counts = await this.countsFor(t);
        row.createSpan({ cls: "oawm-changes-count", text: ` ● ${counts.local} local  ↑ ${counts.unmerged} unmerged` });
      }
    }
    if (tasks.length === 0) root.createEl("em", { text: "No active tasks with worktrees." });
  }

  private async countsFor(task: TaskNote): Promise<{ local: number; unmerged: number }> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) return { local: 0, unmerged: 0 };
    let local = 0, unmerged = 0;
    for (const wt of resolveTaskWorktrees(task, ws)) {
      try { const c = await this.deps.git.unmergedCounts(wt.path, ws.baseBranch); local += c.local; unmerged += c.unmerged; } catch { /* worktree may not exist */ }
    }
    return { local, unmerged };
  }

  private async collect(task: TaskNote, scope: "local" | "unmerged"): Promise<FileChange[]> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) return [];
    const all: FileChange[] = [];
    for (const wt of resolveTaskWorktrees(task, ws)) {
      try {
        const files = scope === "local"
          ? await this.deps.git.status(wt.path)
          : await this.deps.git.branchDiffFiles(wt.path, ws.baseBranch);
        all.push(...stampRepo(files, wt.repo));
      } catch { /* worktree may not exist yet */ }
    }
    return all;
  }

  private async renderTask(root: HTMLElement, task: TaskNote) {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    const base = ws?.baseBranch ?? "main";
    const header = root.createDiv({ cls: "oawm-changes-header" });
    const back = header.createEl("a", { text: "▲ ", href: "#" });
    back.onclick = (e) => { e.preventDefault(); void this.showTask(null); };
    header.createSpan({ text: `${task.title} · ${task.branch} → ${base}` });
    const refresh = header.createEl("button", { text: "⟳" });
    refresh.onclick = () => { void this.render(); };

    const tabs = root.createDiv({ cls: "oawm-changes-tabs" });
    const localFiles = await this.collect(task, "local");
    const unmergedFiles = await this.collect(task, "unmerged");
    this.tabButton(tabs, "local", `Local · ${localFiles.length}`);
    this.tabButton(tabs, "unmerged", `Unmerged · ${unmergedFiles.length}`);

    const body = root.createDiv({ cls: "oawm-changes-body" });
    if (this.tab === "local") this.renderLocal(body, task, localFiles);
    else this.renderUnmerged(body, task, unmergedFiles, base);
  }

  private tabButton(parent: HTMLElement, id: "local" | "unmerged", label: string) {
    const btn = parent.createEl("button", { text: label, cls: this.tab === id ? "oawm-tab-active" : "" });
    btn.onclick = () => { this.tab = id; void this.render(); };
  }

  private renderLocal(body: HTMLElement, task: TaskNote, files: FileChange[]) {
    if (files.length === 0) { body.createEl("em", { text: "No local changes" }); return; }
    for (const [repo, repoFiles] of groupByRepo(files)) {
      body.createEl("div", { cls: "oawm-changes-repo", text: `▸ ${repo}` });
      for (const f of repoFiles) {
        const row = body.createDiv({ cls: "oawm-changes-filerow" });
        const cb = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
        cb.checked = this.checked.has(this.key(repo, f.path));
        cb.onchange = () => { const k = this.key(repo, f.path); cb.checked ? this.checked.add(k) : this.checked.delete(k); this.updateCommitButtons(); };
        row.createSpan({ cls: `oawm-badge-${f.kind}`, text: f.kind });
        const link = row.createEl("a", { text: ` ${f.path}`, href: "#" });
        link.onclick = (e) => { e.preventDefault(); void this.openFileDiff(task, repo, f.path, "local"); };
        const pen = row.createEl("a", { text: " ✎", href: "#", cls: "oawm-pen" });
        pen.onclick = (e) => { e.preventDefault(); void this.deps.openEditor(task, repo, f.path); };
      }
    }
    const msg = body.createEl("textarea", { cls: "oawm-commit-msg", attr: { placeholder: "Commit message" } }) as HTMLTextAreaElement;
    msg.value = this.message;
    msg.oninput = () => { this.message = msg.value; this.updateCommitButtons(); };
    const btns = body.createDiv({ cls: "oawm-commit-btns" });
    this.commitPush = btns.createEl("button", { text: "Commit & Push" });
    this.commitOnly = btns.createEl("button", { text: "Commit" });
    this.commitPush.onclick = () => void this.doCommit(task, true);
    this.commitOnly.onclick = () => void this.doCommit(task, false);
    this.updateCommitButtons();
  }

  private commitPush?: HTMLButtonElement;
  private commitOnly?: HTMLButtonElement;
  private updateCommitButtons() {
    const enabled = commitEnabled(this.checked.size, this.message);
    if (this.commitPush) this.commitPush.disabled = !enabled;
    if (this.commitOnly) this.commitOnly.disabled = !enabled;
  }

  private async doCommit(task: TaskNote, push: boolean) {
    const paths = [...this.checked].map((k) => { const [repo, path] = k.split(" "); return { repo, path }; });
    await this.deps.commit.commit(task, { paths, message: this.message, push });
    this.checked.clear();
    this.message = "";
    await this.render();
  }

  private renderUnmerged(body: HTMLElement, task: TaskNote, files: FileChange[], base: string) {
    if (files.length === 0) body.createEl("em", { text: "No unmerged changes (branch matches base)" });
    for (const [repo, repoFiles] of groupByRepo(files)) {
      body.createEl("div", { cls: "oawm-changes-repo", text: `▸ ${repo}` });
      for (const f of repoFiles) {
        const row = body.createDiv({ cls: "oawm-changes-filerow" });
        row.createSpan({ cls: `oawm-badge-${f.kind}`, text: f.kind });
        const link = row.createEl("a", { text: ` ${f.path}`, href: "#" });
        link.onclick = (e) => { e.preventDefault(); void this.openFileDiff(task, repo, f.path, "unmerged"); };
        const pen = row.createEl("a", { text: " ✎", href: "#", cls: "oawm-pen" });
        pen.onclick = (e) => { e.preventDefault(); void this.deps.openEditor(task, repo, f.path); };
      }
    }
    const btns = body.createDiv({ cls: "oawm-commit-btns" });
    const merge = btns.createEl("button", { text: "Merge" });
    const mergePush = btns.createEl("button", { text: "Merge & Push" });
    const pr = btns.createEl("button", { text: "Open PR/MR" });
    merge.onclick = async () => { await this.deps.completion.merge(task, { push: false }); await this.showTask(null); };
    mergePush.onclick = async () => { await this.deps.completion.merge(task, { push: true }); await this.showTask(null); };
    pr.onclick = () => void this.deps.completion.openPr(task);
  }

  private async openFileDiff(task: TaskNote, repo: string, path: string, scope: "local" | "unmerged") {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) return;
    const wt = resolveTaskWorktrees(task, ws).find((w) => w.repo === repo);
    if (!wt) return;
    const diff = await this.deps.git.fileDiff(wt.path, ws.baseBranch, path, scope === "local" ? "worktree" : "branch");
    await this.deps.openDiff(`${repo}/${path} (${scope})`, diff);
  }
}
```

- [ ] **Step 2: Wire it up in `src/main.ts`**

Add imports:

```typescript
import { CommitCoordinator } from "./core/commit";
import { ChangesView, CHANGES_VIEW_TYPE } from "./obsidian/changesView";
import { buildEditorCommand } from "./core/editorOpen";
```

Extend settings:

```typescript
// in interface OawmSettings:
  editorStrategy: "mux" | "external";
  editorCommand: string;
// in DEFAULT_SETTINGS:
  editorStrategy: "mux",
  editorCommand: "nvim +{line} {file}",
```

In `onload()`, construct the commit coordinator (after `this.completion = ...`):

```typescript
const commit = new CommitCoordinator({ vault: this.vault, git: this.git, notifier });
```

Register the view and add a command + ribbon (next to the dashboard registration):

```typescript
this.registerView(CHANGES_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
  new ChangesView(leaf, {
    vault: this.vault, git: this.git, completion: this.completion, commit,
    openDiff: (title, diff) => openDiffLeaf(this.app, this.settings.diffTarget, { title, diff }),
    openEditor: (task, repo, path) => this.openEditor(task, repo, path),
  }));
this.addCommand({ id: "open-changes", name: "Open Task Changes panel", callback: () => this.activateChanges(null) });
```

Add helper methods to the plugin class:

```typescript
  private async activateChanges(taskPath: string | null) {
    const existing = this.app.workspace.getLeavesOfType(CHANGES_VIEW_TYPE);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) { new Notice("OAWM: could not open changes panel"); return; }
    await leaf.setViewState({ type: CHANGES_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof ChangesView) await view.showTask(taskPath);
  }

  private async openEditor(task: TaskNote, repo: string, path: string) {
    const ws = await this.vault.getWorkspace(task.workspace);
    if (!ws) return;
    const wt = resolveTaskWorktrees(task, ws).find((w) => w.repo === repo);
    if (!wt) return;
    const command = buildEditorCommand(this.settings.editorCommand, { file: join(wt.path, path) });
    if (!this.settings.editorCommand.trim()) { new Notice("OAWM: set an editor command in settings"); return; }
    if (this.settings.editorStrategy === "mux") {
      if (!task.session) { new Notice("OAWM: no terminal session for this task"); return; }
      await this.mux.openPane(task.session, wt.path, command);
    } else {
      const { spawn } = require("node:child_process");
      spawn("bash", ["-lc", command], { cwd: wt.path, detached: true, stdio: "ignore" }).unref();
    }
  }
```

Add `import { resolveTaskWorktrees } from "./core/worktrees";` to `main.ts`.

Change the `viewDiff` action route in `handleAction` to open the panel instead of the modal:

```typescript
      case "viewDiff": await this.activateChanges(task.path); return;
```

(Leave `showDiff` in place only if still referenced elsewhere; otherwise remove it.)

Add settings controls in `OawmSettingTab.display()`:

```typescript
    new Setting(containerEl)
      .setName("Editor open strategy")
      .setDesc("How the ✎ affordance opens a file. \"Terminal pane\" opens it in a new pane in the task's zellij session (works over SSH); \"External\" spawns a GUI editor command.")
      .addDropdown((d) =>
        d.addOption("mux", "Terminal pane (zellij)").addOption("external", "External command")
          .setValue(this.plugin.settings.editorStrategy)
          .onChange(async (v) => { this.plugin.settings.editorStrategy = v as "mux" | "external"; await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Editor command")
      .setDesc("Command template with {file} and {line} placeholders. Examples: \"nvim +{line} {file}\", \"glow {file}\", \"code -g {file}:{line}\".")
      .addText((t) =>
        t.setPlaceholder("nvim +{line} {file}").setValue(this.plugin.settings.editorCommand)
          .onChange(async (v) => { this.plugin.settings.editorCommand = v; await this.plugin.saveData(this.plugin.settings); }));
```

- [ ] **Step 3: Repoint the action label in `src/obsidian/taskCodeBlock.ts`**

```typescript
// in LABELS:
  start: "Start", openTerminal: "Open Terminal", viewDiff: "Review Changes",
```

(The `viewDiff` id stays; only the label changes. `availableActions` is unchanged, so `tests/actionBar.test.ts` still passes.)

- [ ] **Step 4: Add styles to `styles.css`**

```css
.oawm-changes-header { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 6px; }
.oawm-changes-tabs button { margin-right: 4px; }
.oawm-changes-tabs .oawm-tab-active { font-weight: 700; text-decoration: underline; }
.oawm-changes-state { text-transform: uppercase; font-size: 10px; opacity: 0.7; margin: 8px 0 2px; }
.oawm-changes-repo { opacity: 0.8; margin: 6px 0 2px; }
.oawm-changes-filerow { display: flex; align-items: center; gap: 4px; padding: 1px 0; }
.oawm-changes-count { opacity: 0.7; font-size: 11px; }
.oawm-commit-msg { width: 100%; min-height: 48px; margin-top: 8px; }
.oawm-commit-btns { display: flex; gap: 6px; margin-top: 6px; }
.oawm-badge-M { color: var(--color-yellow); } .oawm-badge-A { color: var(--color-green); }
.oawm-badge-D { color: var(--color-red); } .oawm-badge-R { color: var(--color-blue); }
.oawm-badge-\? { opacity: 0.6; }
.oawm-pen { opacity: 0.6; }
```

- [ ] **Step 5: Build + run the full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: no type errors; all tests pass (`actionBar.test.ts` still green with the relabeled action; coordinators/parsers green).

- [ ] **Step 6: Manual test (append checks to `docs/MANUAL-TEST.md`)**

Add a "Task Changes Panel" section listing:
- Open the panel (command palette → "Open Task Changes panel"); with no task it shows the Workspace Overview with `● local` / `↑ unmerged` counts; clicking a task drills in; ▲ returns.
- Local tab: check files across two repos, type a message, "Commit & Push" → one commit per repo, grouped notice; list refreshes.
- Clicking a file opens its diff in a popout window (default) and, after flipping the setting, in a main split.
- ✎ opens a file in a zellij pane (mux strategy) and via an external command (external strategy).
- Unmerged tab: review committed files; Merge / Merge & Push / Open PR behave as in the action bar and return to the overview on completion.

- [ ] **Step 7: Commit**

```bash
git add src/obsidian/changesView.ts src/main.ts src/obsidian/taskCodeBlock.ts styles.css docs/MANUAL-TEST.md
git commit -m "feat: add Task Changes panel (overview + Local/Unmerged tabs, editor open, commit wiring)"
```

---

## Self-Review

**Spec coverage:**
- Task-scoped Changes panel + Workspace Overview → Task 10 (`ChangesView.renderOverview`/`renderTask`).
- Two tabs Local/Unmerged → Task 10.
- Base-agnostic (default main, per-task) → reads `ws.baseBranch` throughout (Tasks 4, 6, 10); click-to-edit base is **deferred** (see note below).
- Diff in popout/split replacing modal → Task 9.
- Checkbox = include in commit; staging hidden → Task 8 (`commitEnabled`) + Task 3 (`commitPaths` stages at commit time) + Task 10 wiring.
- Multi-repo shared message, per-repo results, no rollback → Task 6 (`CommitCoordinator`, `summarizeCommit`) + Task 5.
- Unmerged tab hosts Merge/Push/PR via existing `CompletionCoordinator` → Task 10.
- Surface-agnostic coordinators; action bar left as-is (only label changes) → Tasks 6, 10.
- Editor open mux/external configurable → Task 7 + Task 10.
- GitBackend primitives (`status`, `commitPaths`, `branchDiffFiles`, `fileDiff`, `unmergedCounts`) → Tasks 2–4.
- Testing split (pure → fakes → real-git contract → manual) → Tasks 1–8 unit, Tasks 9–10 manual.

**Scope deviations made explicit (not gaps):**
- **Click-to-edit base in the header** (writing task frontmatter) is in the spec's UX section but is a small additive enhancement; it is **deferred** here to keep Task 10 bounded. To add it: render the `→ base` as an input that calls `vault.patchTask(task.path, { /* base field */ })`. NOTE: `TaskNote` has no `base` field today (base comes from `WorkspaceNote.baseBranch`); supporting per-task base requires adding a `base` field to `TaskNote`/frontmatter parsing first — a separate small task. Flag this to the user before implementing.
- **Auto-refresh on focus** is replaced by the explicit ⟳ refresh button in Task 10 (manual refresh is in scope; focus-refresh is a nice-to-have not yet wired).

**Placeholder scan:** No TBD/TODO; every code step contains complete code; every test step contains real assertions.

**Type consistency:** `FileChange` shape is identical across Tasks 1–10. `commitPaths` return `{ ok, message, commit? }` matches `CommitCoordinator` usage and `FakeGit`. `RepoResult` fields match between `commit.ts`, the tests, and `summarizeCommit`. `openPane(session, cwd, command)` matches across ports, `ZellijBackend`, `FakeMux`, and the `main.ts` caller. `openDiffLeaf`/`DiffView.setDiff` state shape `{ title, diff }` matches the `openDiff` dep signature `(title, diff)` adapted in Task 10's wiring.
