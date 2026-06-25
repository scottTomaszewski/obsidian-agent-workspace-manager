import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/core/orchestrator";
import { FakeVault, FakeGit, FakeMux, FakeAgent, FakeNotifier } from "./fakes";
import type { WorkspaceNote, AgentNote } from "../src/domain/types";

const ws: WorkspaceNote = {
  name: "W", repositories: [{ name: "repo", path: "/code/repo" }],
  isolation: "worktree", baseBranch: "main",
  git: { user: "V", email: "v@e" }, mux: { backend: "zellij" }, host: { type: "local" }, env: {},
};
const agent: AgentNote = { name: "vexa", provider: "claude", account: { configDir: "/c" } };

function make() {
  const vault = new FakeVault();
  const git = new FakeGit();
  const mux = new FakeMux();
  const agentBackend = new FakeAgent(); agentBackend.mux = mux;
  const notifier = new FakeNotifier();
  vault.workspaces.set("W", ws);
  vault.agents.set("vexa", agent);
  const orch = new Orchestrator({ vault, git, mux, agent: agentBackend, notifier, vaultRoot: "/vault" });
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

  it("merges and removes worktree on Completed when clean", async () => {
    const { vault, git, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md");
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md");
    expect(git.merged).toContain("oawm/ds-1-t");
    expect(git.worktrees.has("ds-1-t")).toBe(false);
  });

  it("refuses worktree removal with dirty work unless confirmed", async () => {
    const { vault, git, notifier, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md");
    git.dirty = true;
    notifier.confirmAnswer = false;
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md");
    expect(git.worktrees.has("ds-1-t")).toBe(true); // not removed
  });

  it("repo-direct completion: kills session and idles without merge", async () => {
    const { vault, git, mux, orch } = make();
    vault.workspaces.set("W", { ...ws, isolation: "repo-direct" });
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md"); // launch in repo-direct mode (no worktree)
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md"); // offerMerge → no-merge finalization
    const t = await vault.getTask("T.md");
    expect(git.merged).toHaveLength(0); // no merge for repo-direct
    expect(await mux.isAlive("oawm-DS-1")).toBe(false);
    expect(t?.agentState).toBe("Idle");
  });

  it("does not re-merge on second reconcile after clean completion", async () => {
    const { vault, git, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md"); // launch
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md"); // first merge
    expect(git.merged).toHaveLength(1);
    await orch.reconcileTask("T.md"); // second reconcile — idempotent guard
    expect(git.merged).toHaveLength(1); // branch not merged a second time
  });

  it("dirty-decline: finalizes (Idle, session killed) but keeps worktree", async () => {
    const { vault, git, mux, notifier, orch } = make();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running" });
    await orch.reconcileTask("T.md"); // launch
    git.dirty = true;
    notifier.confirmAnswer = false;
    await vault.patchTask("T.md", { status: "Completed", agentState: "NeedsReview" });
    await orch.reconcileTask("T.md"); // dirty-decline path
    const t = await vault.getTask("T.md");
    expect(git.worktrees.has("ds-1-t")).toBe(true); // worktree preserved
    expect(t?.agentState).toBe("Idle");
    expect(await mux.isAlive("oawm-DS-1")).toBe(false);
  });
});
