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
      vaultRoot: "/v",
    });
    expect(res.session).toContain("T-1");
    expect(a.launches).toHaveLength(1);
  });
});
