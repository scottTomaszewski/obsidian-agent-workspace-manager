import { describe, it, expect } from "vitest";
import { parseMarker, StatusIngest } from "../src/core/statusIngest";
import { FakeVault } from "./fakes";

describe("parseMarker", () => {
  it("maps waiting and review events", () => {
    expect(parseMarker(JSON.stringify({ event: "waiting" }))).toEqual({ state: "Waiting" });
    expect(parseMarker(JSON.stringify({ event: "review" }))).toEqual({ state: "NeedsReview" });
  });
  it("returns null for junk", () => {
    expect(parseMarker("not json")).toBeNull();
    expect(parseMarker(JSON.stringify({ event: "weird" }))).toBeNull();
  });
});

describe("StatusIngest", () => {
  it("patches the matching task's agentState and reconciles", async () => {
    const vault = new FakeVault();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running", agentState: "Running" });
    const reconciled: string[] = [];
    const ingest = new StatusIngest({ vault, reconcile: async (p) => { reconciled.push(p); } });
    await ingest.ingest("DS-1", JSON.stringify({ event: "review" }));
    expect((await vault.getTask("T.md"))?.agentState).toBe("NeedsReview");
    expect(reconciled).toEqual(["T.md"]);
  });
  it("ignores markers for unknown task ids", async () => {
    const vault = new FakeVault();
    const ingest = new StatusIngest({ vault, reconcile: async () => {} });
    await ingest.ingest("NOPE", JSON.stringify({ event: "waiting" }));
    // no throw, nothing patched
    expect(await vault.listTasks()).toHaveLength(0);
  });
  it("does not downgrade NeedsReview to Waiting (idle notification after finish)", async () => {
    const vault = new FakeVault();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running", agentState: "NeedsReview" });
    const reconciled: string[] = [];
    const ingest = new StatusIngest({ vault, reconcile: async (p) => { reconciled.push(p); } });
    await ingest.ingest("DS-1", JSON.stringify({ event: "waiting" }));
    expect((await vault.getTask("T.md"))?.agentState).toBe("NeedsReview");
    expect(reconciled).toEqual([]); // no-op, no reconcile
  });
  it("still upgrades Waiting to NeedsReview when a Stop fires", async () => {
    const vault = new FakeVault();
    vault.seedTask({ path: "T.md", id: "DS-1", title: "T", status: "Running", agentState: "Waiting" });
    const ingest = new StatusIngest({ vault, reconcile: async () => {} });
    await ingest.ingest("DS-1", JSON.stringify({ event: "review" }));
    expect((await vault.getTask("T.md"))?.agentState).toBe("NeedsReview");
  });
});
