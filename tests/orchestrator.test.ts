import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/core/orchestrator";
import { CompletionCoordinator } from "../src/core/completion";
import { FakeVault, FakeGit, FakeMux, FakeAgent, FakeNotifier } from "./fakes";
import type { WorkspaceNote, AgentNote } from "../src/domain/types";

const ws: WorkspaceNote = {
  name: "W", repositories: [{ name: "repo", path: "/code/repo" }],
  isolation: "worktree", baseBranch: "main",
  git: { user: "V", email: "v@e" }, mux: { backend: "zellij" }, host: { type: "local" }, env: {},
};
const agent: AgentNote = { name: "vexa", provider: "claude", account: { configDir: "/c" }, command: "claude", env: {} };

function make() {
  const vault = new FakeVault();
  const git = new FakeGit();
  const mux = new FakeMux();
  const agentBackend = new FakeAgent(); agentBackend.mux = mux;
  const notifier = new FakeNotifier();
  vault.workspaces.set("W", ws);
  vault.agents.set("vexa", agent);
  const completion = new CompletionCoordinator({ vault, git, mux, notifier });
  const orch = new Orchestrator({ vault, git, mux, agent: agentBackend, notifier, vaultRoot: "/vault", completion });
  return { vault, git, mux, agentBackend, notifier, orch };
}

describe("Orchestrator.reconcileTask", () => {
  it("launches a Running task: creates worktree, launches agent, writes state", async () => {
    const { vault, git, mux, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "Add Thing", status: "Running" });
    await orch.reconcileTask("T.md");
    const t = await vault.getTask("T.md");
    expect(git.worktrees.has("ds-1-add-thing")).toBe(true);
    expect(t?.branch).toBe("oawm/ds-1-add-thing");
    expect(t?.session).toBe("oawm-DS-1");
    expect(t?.agentState).toBe("Running");
    expect(await mux.isAlive("oawm-DS-1")).toBe(true);
  });

  it("is idempotent: a second reconcile does not relaunch", async () => {
    const { vault, agentBackend, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md");
    await orch.reconcileTask("T.md");
    expect(agentBackend.launches).toHaveLength(1);
  });

  it("marks Failed when session died while Running", async () => {
    const { vault, notifier, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running", agentState: "Running", session: "oawm-DS-1" });
    // session not alive in mux
    await orch.reconcileTask("T.md");
    const t = await vault.getTask("T.md");
    expect(t?.agentState).toBe("Failed");
    expect(notifier.notices).toContain("Task DS-1: session ended unexpectedly");
  });

  it("kills session and idles on Cancelled", async () => {
    const { vault, mux, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md");
    await vault.patchTask("T.md", { status: "Cancelled" });
    await orch.reconcileTask("T.md");
    const t = await vault.getTask("T.md");
    expect(await mux.isAlive("oawm-DS-1")).toBe(false);
    expect(t?.agentState).toBe("Idle");
  });

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

  it("repo-direct completion: kills session and idles without merge", async () => {
    const { vault, git, mux, orch } = make();
    vault.workspaces.set("W", { ...ws, isolation: "repo-direct" });
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md"); // launch in repo-direct mode (no worktree)
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md"); // offerMerge → no-merge finalization
    const t = await vault.getTask("T.md");
    expect(git.integratedBase).toHaveLength(0); // no merge for repo-direct
    expect(await mux.isAlive("oawm-DS-1")).toBe(false);
    expect(t?.agentState).toBe("Idle");
  });

  it("does not re-merge on second reconcile after clean completion", async () => {
    const { vault, git, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md"); // launch
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md"); // first merge
    expect(git.integratedBase).toHaveLength(1);
    await orch.reconcileTask("T.md"); // second reconcile — idempotent guard
    expect(git.integratedBase).toHaveLength(1); // branch not merged a second time
  });
});
