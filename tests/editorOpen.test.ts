import { describe, it, expect } from "vitest";
import { buildEditorCommand } from "../src/core/editorOpen";

describe("buildEditorCommand", () => {
  it("substitutes {file} and {line}", () => {
    expect(buildEditorCommand("nvim +{line} {file}", { file: "/a/b.ts", line: 42 })).toBe("nvim +42 /a/b.ts");
  });
  it("defaults line to 1 when omitted", () => {
    expect(buildEditorCommand("nvim +{line} {file}", { file: "/a/b.ts" })).toBe("nvim +1 /a/b.ts");
  });
  it("works with templates that omit {line}", () => {
    expect(buildEditorCommand("glow {file}", { file: "/a/b.md" })).toBe("glow /a/b.md");
  });
});
