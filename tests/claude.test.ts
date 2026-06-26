import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildHookSettings, ClaudeBackend, expandTilde, buildAgentCommand } from "../src/backends/claude";
import { FakeMux } from "./fakes";
import type { AgentNote, TaskNote } from "../src/domain/types";

describe("expandTilde", () => {
  it("expands ~ and ~/ to the home directory, leaves other paths alone", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/.claude_personal")).toBe(join(homedir(), ".claude_personal"));
    expect(expandTilde("/abs/path")).toBe("/abs/path");
    expect(expandTilde("relative")).toBe("relative");
  });
});

describe("buildHookSettings", () => {
  it("wires Notification and Stop hooks with the task id and helper path", () => {
    const s = buildHookSettings("DS-1", "/plugin/oawm-hook.mjs", "/vault/.oawm/status");
    const json = JSON.stringify(s);
    expect(json).toContain("DS-1");
    expect(json).toContain("/plugin/oawm-hook.mjs");
    expect(s.hooks.Notification).toBeDefined();
    expect(s.hooks.Stop).toBeDefined();
  });
});

describe("ClaudeBackend.launch", () => {
  it("writes .claude/settings.local.json into the worktree and starts a session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oawm-cc-"));
    const mux = new FakeMux();
    const backend = new ClaudeBackend({ mux, hookHelperPath: "/plugin/oawm-hook.mjs", statusDir: "/vault/.oawm/status" });
    const task = { path: "T.md", id: "DS-1", title: "T" } as TaskNote;
    const agent: AgentNote = { name: "vexa", provider: "claude", account: { configDir: "/cfg" }, command: "claude", env: {} };
    const { session } = await backend.launch({ task, cwd, agent, vaultRoot: "/vault", prompt: "" });
    expect(session).toBe("oawm-DS-1");
    expect(await mux.isAlive("oawm-DS-1")).toBe(true);
    expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8"));
    expect(JSON.stringify(written)).toContain("DS-1");
  });

  it("launches the agent's custom command with merged env and tilde-expanded config dir", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oawm-cc-"));
    const mux = new FakeMux();
    const backend = new ClaudeBackend({ mux, hookHelperPath: "/p/oawm-hook.mjs", statusDir: "/v/.oawm/status" });
    const task = { path: "T.md", id: "DS-2", title: "T" } as TaskNote;
    const agent: AgentNote = {
      name: "personal", provider: "claude",
      account: { configDir: "~/.claude_personal" },
      command: "claude", env: { CLAUDE_CODE_USE_FOUNDRY: "0" },
    };
    await backend.launch({ task, cwd, agent, vaultRoot: "/v", prompt: "" });
    const call = mux.creates.find((c) => c.session === "oawm-DS-2")!;
    expect(call.command).toBe("claude");
    expect(call.env.CLAUDE_CODE_USE_FOUNDRY).toBe("0");
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(join(homedir(), ".claude_personal"));
  });

  it("seeds the agent with the task goal via a prompt file when a prompt is given", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oawm-cc-"));
    const mux = new FakeMux();
    const backend = new ClaudeBackend({ mux, hookHelperPath: "/p/oawm-hook.mjs", statusDir: "/v/.oawm/status" });
    const task = { path: "T.md", id: "DS-3", title: "T" } as TaskNote;
    const agent: AgentNote = { name: "vexa", provider: "claude", account: { configDir: "/cfg" }, command: "claude", env: {} };
    await backend.launch({ task, cwd, agent, vaultRoot: "/v", prompt: "Add a login button" });
    const call = mux.creates.find((c) => c.session === "oawm-DS-3")!;
    // command is `claude "$(cat '<promptfile>')"`; the goal lives in the file, not the argv
    expect(call.command).toMatch(/^claude "\$\(cat '.*prompt\.md'\)"$/);
    const file = call.command.match(/cat '([^']+)'/)![1];
    expect(readFileSync(file, "utf8")).toBe("Add a login button");
  });

  it("clears a stale status marker for the task before launching", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oawm-cc-"));
    const statusDir = mkdtempSync(join(tmpdir(), "oawm-status-"));
    writeFileSync(join(statusDir, "DS-4.json"), JSON.stringify({ event: "review", ts: 1 }));
    const mux = new FakeMux();
    const backend = new ClaudeBackend({ mux, hookHelperPath: "/p/oawm-hook.mjs", statusDir });
    const task = { path: "T.md", id: "DS-4", title: "T" } as TaskNote;
    const agent: AgentNote = { name: "vexa", provider: "claude", account: { configDir: "/cfg" }, command: "claude", env: {} };
    await backend.launch({ task, cwd, agent, vaultRoot: "/v", prompt: "" });
    expect(existsSync(join(statusDir, "DS-4.json"))).toBe(false);
  });
});

describe("buildAgentCommand", () => {
  it("returns the bare command when there is no prompt", () => {
    expect(buildAgentCommand("claude", "")).toBe("claude");
    expect(buildAgentCommand("claude", "   ")).toBe("claude");
  });
});
