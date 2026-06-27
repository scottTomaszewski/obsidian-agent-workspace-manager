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
