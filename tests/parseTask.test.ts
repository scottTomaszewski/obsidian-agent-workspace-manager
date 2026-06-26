import { describe, it, expect } from "vitest";
import { frontmatterToTask, frontmatterToWorkspace, frontmatterToAgent, stripTaskBody } from "../src/obsidian/vaultGateway";

describe("stripTaskBody", () => {
  it("drops frontmatter and oawm-task blocks, returning the trimmed goal", () => {
    const raw = [
      "---",
      "type: task",
      "status: Running",
      "---",
      "",
      "```oawm-task",
      "```",
      "",
      "Add a login button to the header.",
      "",
      "## Acceptance",
      "- works",
      "",
    ].join("\n");
    expect(stripTaskBody(raw)).toBe("Add a login button to the header.\n\n## Acceptance\n- works");
  });

  it("returns the whole content when there is no frontmatter", () => {
    expect(stripTaskBody("just a goal")).toBe("just a goal");
  });
});

describe("frontmatter mappers", () => {
  it("maps a task with defaults for missing system fields", () => {
    const t = frontmatterToTask("Tasks/Add Thing.md", "Add Thing", {
      type: "task", id: "DS-1", workspace: "W", repositories: ["repo"], agent: "vexa", status: "Running",
    });
    expect(t).toMatchObject({
      path: "Tasks/Add Thing.md", id: "DS-1", title: "Add Thing",
      workspace: "W", agent: "vexa", status: "Running", agentState: "",
    });
  });
  it("falls back id to slug of basename when missing", () => {
    const t = frontmatterToTask("Tasks/My Task.md", "My Task", { type: "task", status: "Pending" });
    expect(t.id).toBe("my-task");
  });
  it("maps workspace and agent", () => {
    const w = frontmatterToWorkspace("W", {
      type: "workspace", repositories: [{ name: "repo", path: "/code/repo" }],
      isolation: "worktree", base_branch: "main", git: { user: "V", email: "v@e" },
      mux: { backend: "zellij" }, host: { type: "local" },
    });
    expect(w.baseBranch).toBe("main");
    expect(w.repositories[0].path).toBe("/code/repo");
    const a = frontmatterToAgent("vexa", { type: "agent", provider: "claude", account: { config_dir: "/cfg" } });
    expect(a.account.configDir).toBe("/cfg");
    expect(a.command).toBe("claude"); // default
    expect(a.env).toEqual({});

    const custom = frontmatterToAgent("personal", {
      type: "agent", provider: "claude",
      account: { config_dir: "~/.claude_personal" },
      command: "claude", env: { CLAUDE_CODE_USE_FOUNDRY: "0" },
    });
    expect(custom.command).toBe("claude");
    expect(custom.env).toEqual({ CLAUDE_CODE_USE_FOUNDRY: "0" });
  });
});
