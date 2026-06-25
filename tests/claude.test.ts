import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHookSettings, ClaudeBackend } from "../src/backends/claude";
import { FakeMux } from "./fakes";
import type { AgentNote, TaskNote } from "../src/domain/types";

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
    const agent: AgentNote = { name: "vexa", provider: "claude", account: { configDir: "/cfg" } };
    const { session } = await backend.launch({ task, cwd, agent, vaultRoot: "/vault" });
    expect(session).toBe("oawm-DS-1");
    expect(await mux.isAlive("oawm-DS-1")).toBe(true);
    expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8"));
    expect(JSON.stringify(written)).toContain("DS-1");
  });
});
