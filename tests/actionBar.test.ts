import { describe, it, expect } from "vitest";
import { availableActions } from "../src/obsidian/taskCodeBlock";
import type { TaskNote } from "../src/domain/types";

const base: TaskNote = {
  path: "T.md", id: "DS-1", title: "T", workspace: "W", repositories: ["repo"],
  agent: "vexa", status: "Pending", agentState: "", worktree: "", branch: "", session: "",
};

describe("availableActions", () => {
  it("Pending → start", () => {
    expect(availableActions(base)).toEqual(["start"]);
  });
  it("Running+Running → terminal, diff, cancel", () => {
    expect(availableActions({ ...base, status: "Running", agentState: "Running" }))
      .toEqual(["openTerminal", "viewDiff", "cancel"]);
  });
  it("NeedsReview → terminal, diff, complete, cancel", () => {
    expect(availableActions({ ...base, status: "Running", agentState: "NeedsReview" }))
      .toEqual(["openTerminal", "viewDiff", "complete", "cancel"]);
  });
  it("Failed → restart, cancel", () => {
    expect(availableActions({ ...base, status: "Running", agentState: "Failed" }))
      .toEqual(["restart", "cancel"]);
  });
});
