// tests/commit.test.ts
import { describe, it, expect } from "vitest";
import { CommitCoordinator, summarizeCommit } from "../src/core/commit";
import { FakeGit, FakeVault, FakeNotifier } from "./fakes";
import type { WorkspaceNote } from "../src/domain/types";
import type { CheckoutTarget } from "../src/core/targets";

const ws: WorkspaceNote = {
  name: "W",
  repositories: [{ name: "web", path: "/code/web" }, { name: "api", path: "/code/api" }],
  isolation: "worktree", baseBranch: "main",
  git: { user: "u", email: "e" }, mux: { backend: "zellij" }, host: { type: "local" }, env: {},
};

function setup() {
  const vault = new FakeVault();
  vault.workspaces.set("W", ws);
  const git = new FakeGit();
  const notifier = new FakeNotifier();
  const coord = new CommitCoordinator({ vault, git, notifier });
  return { vault, git, notifier, coord };
}

describe("CommitCoordinator.commit", () => {
  it("commits checked paths per repo with the shared message, then pushes when requested", async () => {
    const { git, coord } = setup();
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
