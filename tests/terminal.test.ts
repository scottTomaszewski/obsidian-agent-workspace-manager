import { describe, it, expect } from "vitest";
import { buildTerminalArgv } from "../src/backends/terminal";

describe("buildTerminalArgv", () => {
  const inner = ["zellij", "attach", "oawm-DS-1"];

  it("prepends a gnome-terminal template", () => {
    expect(buildTerminalArgv("gnome-terminal --", inner)).toEqual([
      "gnome-terminal", "--", "zellij", "attach", "oawm-DS-1",
    ]);
  });

  it("prepends a konsole template", () => {
    expect(buildTerminalArgv("konsole -e", inner)).toEqual([
      "konsole", "-e", "zellij", "attach", "oawm-DS-1",
    ]);
  });

  it("supports a single-token template (kitty)", () => {
    expect(buildTerminalArgv("kitty", inner)).toEqual([
      "kitty", "zellij", "attach", "oawm-DS-1",
    ]);
  });

  it("tolerates extra whitespace in the template", () => {
    expect(buildTerminalArgv("  wezterm  start  --  ", inner)).toEqual([
      "wezterm", "start", "--", "zellij", "attach", "oawm-DS-1",
    ]);
  });
});
