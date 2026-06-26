import { describe, it, expect } from "vitest";
import { zellijArgs, parseAliveSessions, buildLaunchScript } from "../src/backends/zellij";

describe("buildLaunchScript", () => {
  const script = buildLaunchScript("/opt/zellij", "oawm-DS-1", "/wt path", "claude", { CLAUDE_CONFIG_DIR: "/cfg" });

  it("cd's to the worktree and exports the agent env", () => {
    expect(script).toContain("cd '/wt path'");
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/cfg'");
  });
  it("launches the agent in a zellij session using the configured binary path", () => {
    expect(script).toContain("'/opt/zellij' -s 'oawm-DS-1' -- bash -lc 'claude; exec bash'");
  });
  it("keeps the window open after the session ends (error stays visible)", () => {
    expect(script).toContain("ec=$?");
    expect(script.trimEnd().endsWith("exec bash")).toBe(true);
    expect(script).toContain("Window kept open");
  });
});

describe("zellijArgs", () => {
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
