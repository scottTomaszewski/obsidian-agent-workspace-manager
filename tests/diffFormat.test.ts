import { describe, it, expect } from "vitest";
import { splitDiffLines } from "../src/obsidian/diffPanel";

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
