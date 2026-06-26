import { describe, it, expect } from "vitest";
import { FakeVault, FakeGit, FakeMux, FakeAgent, FakeNotifier } from "./fakes";

describe("fakes", () => {
  it("vault stores and patches tasks", async () => {
    const v = new FakeVault();
    v.seedTask({ path: "T.md", id: "T-1", title: "T", status: "Running" });
    await v.patchTask("T.md", { agentState: "Running", session: "s1" });
    const t = await v.getTask("T.md");
    expect(t?.agentState).toBe("Running");
    expect(t?.session).toBe("s1");
  });
  it("mux tracks liveness", async () => {
    const m = new FakeMux();
    await m.create("s1", "/tmp", "claude", {});
    expect(await m.isAlive("s1")).toBe(true);
    await m.kill("s1");
    expect(await m.isAlive("s1")).toBe(false);
  });
  it("agent launch records args and returns a session", async () => {
    const a = new FakeAgent();
    const res = await a.launch({
      task: { path: "T.md", id: "T-1", title: "T" } as any,
      cwd: "/wt", agent: { name: "vexa", provider: "claude", account: { configDir: "/c" }, command: "claude", env: {} },
      vaultRoot: "/v", prompt: "",
    });
    expect(res.session).toContain("T-1");
    expect(a.launches).toHaveLength(1);
  });
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
});
