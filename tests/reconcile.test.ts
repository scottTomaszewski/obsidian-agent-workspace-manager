import { describe, it, expect } from "vitest";
import { decide } from "../src/domain/reconcile";
import { branchName, worktreeDirName, slugify } from "../src/domain/types";

describe("decide", () => {
  it("does nothing while Pending", () => {
    expect(decide({ desired: "Pending", actual: "", sessionAlive: false })).toBe("none");
  });
  it("launches when Running and no live session and not yet started", () => {
    expect(decide({ desired: "Running", actual: "", sessionAlive: false })).toBe("launch");
    expect(decide({ desired: "Running", actual: "Idle", sessionAlive: false })).toBe("launch");
  });
  it("does nothing when Running and session alive", () => {
    expect(decide({ desired: "Running", actual: "Running", sessionAlive: true })).toBe("none");
    expect(decide({ desired: "Running", actual: "Waiting", sessionAlive: true })).toBe("none");
    expect(decide({ desired: "Running", actual: "NeedsReview", sessionAlive: true })).toBe("none");
  });
  it("marks Failed when a running/waiting session dies unexpectedly", () => {
    expect(decide({ desired: "Running", actual: "Running", sessionAlive: false })).toBe("markFailed");
    expect(decide({ desired: "Running", actual: "Waiting", sessionAlive: false })).toBe("markFailed");
  });
  it("does not relaunch after review or failure", () => {
    expect(decide({ desired: "Running", actual: "NeedsReview", sessionAlive: false })).toBe("none");
    expect(decide({ desired: "Running", actual: "Failed", sessionAlive: false })).toBe("none");
  });
  it("kills a live session when Cancelled, else nothing", () => {
    expect(decide({ desired: "Cancelled", actual: "Running", sessionAlive: true })).toBe("killAndIdle");
    expect(decide({ desired: "Cancelled", actual: "Failed", sessionAlive: false })).toBe("none");
  });
  it("offers merge when Completed", () => {
    expect(decide({ desired: "Completed", actual: "NeedsReview", sessionAlive: false })).toBe("offerMerge");
  });
});

describe("naming", () => {
  it("slugifies titles", () => {
    expect(slugify("Add Spell Schema!")).toBe("add-spell-schema");
  });
  it("builds branch and worktree names", () => {
    expect(branchName("DS-123", "Add Spell Schema")).toBe("oawm/ds-123-add-spell-schema");
    expect(worktreeDirName("DS-123", "Add Spell Schema")).toBe("ds-123-add-spell-schema");
  });
});
