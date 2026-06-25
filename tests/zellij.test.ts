import { describe, it, expect } from "vitest";
import { zellijArgs } from "../src/backends/zellij";

describe("zellijArgs", () => {
  it("builds a detached create command running the agent command", () => {
    const args = zellijArgs.create("oawm-DS-1", "/wt", "claude");
    // zellij -s <session> action / new-session pattern:
    expect(args).toContain("oawm-DS-1");
    expect(args.join(" ")).toContain("claude");
  });
  it("builds kill and list commands", () => {
    expect(zellijArgs.kill("oawm-DS-1")).toEqual(["kill-session", "oawm-DS-1"]);
    expect(zellijArgs.list()).toEqual(["list-sessions", "--no-formatting"]);
  });
});
