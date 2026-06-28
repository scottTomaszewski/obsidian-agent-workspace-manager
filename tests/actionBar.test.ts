import { describe, it, expect } from "vitest";
import { availableActions } from "../src/obsidian/taskCodeBlock";
import type { TaskNote } from "../src/domain/types";

const base: TaskNote = {
  path: "T.md", id: "DS-1", title: "T", workspace: "W", repositories: ["repo"],
  agent: "vexa", status: "Pending", agentState: "", worktree: "", branch: "", session: "",
};
const active = (agentState: TaskNote["agentState"], extra: Partial<TaskNote> = {}): TaskNote =>
  ({ ...base, status: "Running", agentState, branch: "oawm/ds-1-t", session: "oawm-DS-1", ...extra });

describe("availableActions", () => {
  it("Pending → start", () => {
    expect(availableActions(base)).toEqual(["start"]);
  });
  it("active (NeedsReview) → terminal, diff, the four git actions, cancel", () => {
    expect(availableActions(active("NeedsReview")))
      .toEqual(["openTerminal", "viewDiff", "merge", "mergePush", "push", "openPr", "cancel"]);
  });
  it("active (Waiting) → same git actions available", () => {
    expect(availableActions(active("Waiting")))
      .toEqual(["openTerminal", "viewDiff", "merge", "mergePush", "push", "openPr", "cancel"]);
  });
  it("active (Running) → git actions available (branch exists)", () => {
    expect(availableActions(active("Running")))
      .toEqual(["openTerminal", "viewDiff", "merge", "mergePush", "push", "openPr", "cancel"]);
  });
  it("Failed with a session → openTerminal + restart + cancel (no git actions)", () => {
    expect(availableActions(active("Failed")))
      .toEqual(["openTerminal", "restart", "cancel"]);
  });
  it("Failed but the worktree still exists → Review stays available", () => {
    const t: TaskNote = {
      ...base, status: "Running", agentState: "Failed",
      branch: "oawm/ds-1-t", worktree: ".oawm-worktrees/ds-1-t",
    };
    expect(availableActions(t)).toEqual(["viewDiff", "restart", "cancel"]);
  });
  it("active but no branch yet → no git actions", () => {
    expect(availableActions({ ...active("Running"), branch: "" }))
      .toEqual(["openTerminal", "viewDiff", "cancel"]);
  });
});
