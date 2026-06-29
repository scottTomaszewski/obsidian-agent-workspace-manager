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
