import { describe, it, expect } from "vitest";
import { zellijArgs, parseAliveSessions } from "../src/backends/zellij";

describe("zellijArgs", () => {
  it("creates a session whose script cd's to the cwd, exports env, and runs the command", () => {
    const args = zellijArgs.create("oawm-DS-1", "/wt path", "claude", { CLAUDE_CONFIG_DIR: "/cfg" });
    expect(args.slice(0, 5)).toEqual(["-s", "oawm-DS-1", "--", "bash", "-lc"]);
    const script = args[5];
    expect(script).toContain("cd '/wt path'");
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/cfg'");
    expect(script).toContain("claude");
    expect(script).toContain("exec bash");
  });
  it("builds attach, kill and list commands", () => {
    expect(zellijArgs.attach("oawm-DS-1")).toEqual(["attach", "oawm-DS-1"]);
    expect(zellijArgs.kill("oawm-DS-1")).toEqual(["kill-session", "oawm-DS-1"]);
    expect(zellijArgs.list()).toEqual(["list-sessions", "--no-formatting"]);
  });
});

describe("parseAliveSessions", () => {
  const sampleOutput = [
    "oawm-DS-1  [Created 2m ago]",
    "oawm-DS-12 [Created 5m ago]",
    "oawm-DS-3  [Created 10m ago] (EXITED 1m ago)",
    "",
  ].join("\n");

  it("returns names of non-exited sessions", () => {
    expect(parseAliveSessions(sampleOutput)).toEqual(["oawm-DS-1", "oawm-DS-12"]);
  });

  it("exact-matches active session (not prefix-matches siblings)", () => {
    expect(parseAliveSessions(sampleOutput).includes("oawm-DS-1")).toBe(true);
    expect(parseAliveSessions(sampleOutput).includes("oawm-DS-3")).toBe(false);
    expect(parseAliveSessions(sampleOutput).includes("oawm-DS-99")).toBe(false);
  });

  it("excludes EXITED sessions regardless of case", () => {
    const mixed = "my-session  [exited]\nother-session  [EXITED]\ngood-session  [active]";
    expect(parseAliveSessions(mixed)).toEqual(["good-session"]);
  });

  it("handles empty output", () => {
    expect(parseAliveSessions("")).toEqual([]);
    expect(parseAliveSessions("   \n  ")).toEqual([]);
  });
});
