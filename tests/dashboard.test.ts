import { describe, it, expect } from "vitest";
import { groupByState } from "../src/obsidian/dashboardView";
import type { TaskNote } from "../src/domain/types";

function t(id: string, status: TaskNote["status"], agentState: TaskNote["agentState"]): TaskNote {
  return { path: id + ".md", id, title: id, workspace: "W", repositories: ["r"], agent: "vexa",
    status, agentState, worktree: "", branch: "", session: "" };
}

describe("groupByState", () => {
  it("buckets tasks by their effective display state", () => {
    const groups = groupByState([
      t("A", "Pending", ""),
      t("B", "Running", "Running"),
      t("C", "Running", "NeedsReview"),
      t("D", "Running", "Waiting"),
    ]);
    expect(groups.Pending.map((x) => x.id)).toEqual(["A"]);
    expect(groups.Running.map((x) => x.id)).toEqual(["B"]);
    expect(groups.NeedsReview.map((x) => x.id)).toEqual(["C"]);
    expect(groups.Waiting.map((x) => x.id)).toEqual(["D"]);
  });
});
