import { describe, it, expect } from "vitest";
import { splitDiffLines, classifyDiffLine, buildSideBySide } from "../src/obsidian/diffPanel";

describe("splitDiffLines", () => {
  it("classifies diff lines", () => {
    const lines = splitDiffLines([
      "diff --git a/x b/x",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      " same",
    ].join("\n"));
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "del", "add", "ctx"]);
  });
});

describe("classifyDiffLine", () => {
  it("classifies the diff marker lines", () => {
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("meta");
    expect(classifyDiffLine("--- a/x")).toBe("meta");
    expect(classifyDiffLine("+++ b/x")).toBe("meta");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine(" context")).toBe("ctx");
  });
});

describe("buildSideBySide", () => {
  it("pairs changed lines and numbers context from the hunk header", () => {
    const rows = buildSideBySide([
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
    ].join("\n"));
    expect(rows.map((r) => r.type)).toEqual(["meta", "line", "line", "line"]);
    expect(rows[1]).toEqual({
      type: "line",
      left: { lineNo: 1, text: "a", kind: "ctx" },
      right: { lineNo: 1, text: "a", kind: "ctx" },
    });
    expect(rows[2]).toEqual({
      type: "line",
      left: { lineNo: 2, text: "b", kind: "del" },
      right: { lineNo: 2, text: "B", kind: "add" },
    });
    expect(rows[3].type === "line" && rows[3].right).toEqual({ lineNo: 3, text: "c", kind: "ctx" });
  });

  it("leaves the right cell null for a pure deletion", () => {
    const rows = buildSideBySide(["@@ -1,2 +1,1 @@", " a", "-b"].join("\n"));
    expect(rows[2]).toEqual({
      type: "line",
      left: { lineNo: 2, text: "b", kind: "del" },
      right: null,
    });
  });

  it("leaves the left cell null for a pure addition", () => {
    const rows = buildSideBySide(["@@ -1,1 +1,2 @@", " a", "+b"].join("\n"));
    expect(rows[2]).toEqual({
      type: "line",
      left: null,
      right: { lineNo: 2, text: "b", kind: "add" },
    });
  });

  it("flushes a pending change run at a hunk boundary (multi-hunk)", () => {
    // First hunk ends on a +/- change with no trailing context, immediately
    // followed by the next @@ — the change must flush before the new meta row,
    // and line numbers must re-seed from each hunk header.
    const rows = buildSideBySide([
      "@@ -1,1 +1,1 @@",
      "-a",
      "+A",
      "@@ -10,1 +10,1 @@",
      "-x",
      "+y",
    ].join("\n"));
    expect(rows.map((r) => r.type)).toEqual(["meta", "line", "meta", "line"]);
    expect(rows[1]).toEqual({
      type: "line",
      left: { lineNo: 1, text: "a", kind: "del" },
      right: { lineNo: 1, text: "A", kind: "add" },
    });
    expect(rows[3]).toEqual({
      type: "line",
      left: { lineNo: 10, text: "x", kind: "del" },
      right: { lineNo: 10, text: "y", kind: "add" },
    });
  });
});
