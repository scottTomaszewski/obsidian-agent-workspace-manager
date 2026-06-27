import { describe, it, expect } from "vitest";
import { parseStatus, parseNameStatus, groupByRepo, kindBadge, type FileChange } from "../src/core/changes";

describe("parseStatus (git status --porcelain v1)", () => {
  it("parses staged, unstaged, untracked, deleted, and renamed entries", () => {
    const out = [
      "M  src/staged.ts",     // staged modify
      " M src/unstaged.ts",   // unstaged modify
      "?? src/new.ts",        // untracked
      " D src/gone.ts",       // unstaged delete
      "A  src/added.ts",      // staged add
      "R  src/old.ts -> src/renamed.ts", // staged rename
    ].join("\n");
    expect(parseStatus(out)).toEqual<FileChange[]>([
      { path: "src/staged.ts", repo: "", staged: true, kind: "M" },
      { path: "src/unstaged.ts", repo: "", staged: false, kind: "M" },
      { path: "src/new.ts", repo: "", staged: false, kind: "?" },
      { path: "src/gone.ts", repo: "", staged: false, kind: "D" },
      { path: "src/added.ts", repo: "", staged: true, kind: "A" },
      { path: "src/renamed.ts", repo: "", staged: true, kind: "R" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseStatus("")).toEqual([]);
    expect(parseStatus("\n")).toEqual([]);
  });
});

describe("parseNameStatus (git diff --name-status)", () => {
  it("parses M/A/D and rename rows", () => {
    const out = ["M\tsrc/a.ts", "A\tsrc/b.ts", "D\tsrc/c.ts", "R100\tsrc/old.ts\tsrc/new.ts"].join("\n");
    expect(parseNameStatus(out)).toEqual<FileChange[]>([
      { path: "src/a.ts", repo: "", staged: false, kind: "M" },
      { path: "src/b.ts", repo: "", staged: false, kind: "A" },
      { path: "src/c.ts", repo: "", staged: false, kind: "D" },
      { path: "src/new.ts", repo: "", staged: false, kind: "R" },
    ]);
  });
});

describe("groupByRepo", () => {
  it("groups files by repo, preserving order", () => {
    const files: FileChange[] = [
      { path: "a", repo: "web", staged: false, kind: "M" },
      { path: "b", repo: "api", staged: false, kind: "A" },
      { path: "c", repo: "web", staged: false, kind: "M" },
    ];
    const g = groupByRepo(files);
    expect([...g.keys()]).toEqual(["web", "api"]);
    expect(g.get("web")!.map((f) => f.path)).toEqual(["a", "c"]);
  });
});

describe("kindBadge", () => {
  it("maps kinds to letters", () => {
    expect(kindBadge("M")).toBe("M");
    expect(kindBadge("?")).toBe("?");
    expect(kindBadge("R")).toBe("R");
  });
});
