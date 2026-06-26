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
  // Seed agentState "Running" (not "NeedsReview") so a transition TO NeedsReview
  // is actually observable in the assertions below.
  vault.seedTask({
    path: "T.md", id: "DS-1", title: "Add Thing", workspace: "W", repositories: ["repo"],
    agent: "vexa", status: "Running", agentState: "Running",
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
    expect((await vault.getTask("T.md"))?.agentState).toBe("NeedsReview");
    expect(notifier.notices.join(" ")).toMatch(/commit the in-progress merge/i);
  });

  it("conflict via reconcile path (status already Completed): flips status back to Running so retry is possible", async () => {
    const { vault, git, c } = make();
    // Simulate the orchestrator reconcile entry: status Completed, still NeedsReview.
    vault.seedTask({
      path: "T.md", id: "DS-1", title: "Add Thing", workspace: "W", repositories: ["repo"],
      agent: "vexa", status: "Completed", agentState: "NeedsReview",
      branch: "oawm/ds-1-add-thing", worktree: "/code/repo/.oawm-worktrees/ds-1-add-thing", session: "oawm-DS-1",
    });
    git.conflicts = true;
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    const t = await vault.getTask("T.md");
    expect(t?.status).toBe("Running"); // so availableActions surfaces the retry buttons
    expect(t?.agentState).toBe("NeedsReview");
    expect(git.removeCalls).toEqual([]);
  });

  it("repo-direct: finalizes without merging (Completed, Idle, session killed)", async () => {
    const { vault, git, mux, c } = make();
    vault.workspaces.set("W", { ...ws, isolation: "repo-direct" });
    vault.seedTask({
      path: "T.md", id: "DS-1", title: "Add Thing", workspace: "W", repositories: ["repo"],
      agent: "vexa", status: "Running", agentState: "Running", branch: "", worktree: "", session: "oawm-DS-1",
    });
    await c.merge((await vault.getTask("T.md"))!, { push: false });
    expect(git.integratedBase).toEqual([]);
    expect(mux.alive.has("oawm-DS-1")).toBe(false);
    const t = await vault.getTask("T.md");
    expect(t?.status).toBe("Completed");
    expect(t?.agentState).toBe("Idle");
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

  it("dirty + decline: aborts the push, never discards", async () => {
    const { vault, git, notifier, c } = make();
    seedActive(vault);
    git.dirty = true;
    notifier.confirmAnswer = false;
    await c.pushBranch((await vault.getTask("T.md"))!);
    expect(git.pushedBranches).toEqual([]);
    expect(git.removeCalls).toEqual([]);
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

  it("dirty + decline: aborts, no push and no URL", async () => {
    const { vault, git, notifier, c } = make();
    git.remoteUrl = "git@github.com:acme/widget.git";
    seedActive(vault);
    git.dirty = true;
    notifier.confirmAnswer = false;
    const res = await c.openPr((await vault.getTask("T.md"))!);
    expect(git.pushedBranches).toEqual([]);
    expect(res.url).toBeUndefined();
  });
});
