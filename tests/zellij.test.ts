import { describe, it, expect } from "vitest";
import { zellijArgs, parseAliveSessions, buildLaunchScript, buildLayout, newPaneArgs, ZellijBackend, labelFromSession } from "../src/backends/zellij";
import type { TerminalLauncher } from "../src/backends/terminal";

class FakeTerminalLauncher implements TerminalLauncher {
  calls: { inner: string[]; opts?: { cwd?: string; env?: Record<string,string>; key?: string; title?: string } }[] = [];
  async open(inner: string[], opts?: any) { this.calls.push({ inner, opts }); }
}

describe("buildLayout", () => {
  it("runs the command in a bash pane that stays open", () => {
    expect(buildLayout("claude")).toContain(`pane command="bash"`);
    expect(buildLayout("claude")).toContain(`args "-lc" "claude; exec bash"`);
  });
  it("escapes quotes/backslashes in the command", () => {
    expect(buildLayout(`claude --x "y"`)).toContain(`args "-lc" "claude --x \\"y\\"; exec bash"`);
  });
});

describe("buildLaunchScript", () => {
  const script = buildLaunchScript("/opt/zellij", "oawm-DS-1", "/wt path", { CLAUDE_CONFIG_DIR: "/cfg" }, "/tmp/l.kdl");

  it("cd's to the worktree and exports the agent env", () => {
    expect(script).toContain("cd '/wt path'");
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/cfg'");
  });
  it("starts a new named session with the layout via -n, using the configured binary", () => {
    expect(script).toContain("'/opt/zellij' -s 'oawm-DS-1' -n '/tmp/l.kdl'");
    expect(script).not.toContain("-- bash"); // the invalid trailing-command form is gone
    expect(script).not.toContain(" -l "); // -l with -s adds a tab to an existing session, not what we want
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

describe("newPaneArgs", () => {
  it("targets the session and runs the command in a new pane", () => {
    expect(newPaneArgs("oawm-DS-1", "/code/web", "nvim +5 a.ts")).toEqual([
      "--session", "oawm-DS-1", "action", "new-pane", "--cwd", "/code/web", "--", "bash", "-lc", "nvim +5 a.ts",
    ]);
  });
});

describe("labelFromSession", () => {
  it("strips the oawm- prefix", () => {
    expect(labelFromSession("oawm-DS-1")).toBe("DS-1");
  });
  it("leaves a non-prefixed name unchanged", () => {
    expect(labelFromSession("custom")).toBe("custom");
  });
});

describe("ZellijBackend with injected launcher", () => {
  it("create() opens a bash script keyed/titled by the session", async () => {
    const launcher = new FakeTerminalLauncher();
    const zb = new ZellijBackend(launcher, "/opt/zellij");
    await zb.create("oawm-DS-1", "/wt", "claude", { K: "v" });
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0].inner[0]).toBe("bash");
    expect(launcher.calls[0].opts?.key).toBe("oawm-DS-1");
    expect(launcher.calls[0].opts?.title).toBe("DS-1");
  });

  it("focus() reattaches keyed/titled by the session", async () => {
    const launcher = new FakeTerminalLauncher();
    const zb = new ZellijBackend(launcher, "/opt/zellij");
    await zb.focus("oawm-DS-1");
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0].opts?.key).toBe("oawm-DS-1");
    expect(launcher.calls[0].opts?.title).toBe("DS-1");
  });
});
