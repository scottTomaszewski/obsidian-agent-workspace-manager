import { describe, it, expect } from "vitest";
import { parseRemote, compareUrl } from "../src/core/remote";

describe("parseRemote", () => {
  it("parses GitHub ssh and https remotes", () => {
    expect(parseRemote("git@github.com:acme/widget.git")).toEqual({ host: "github", owner: "acme", repo: "widget" });
    expect(parseRemote("https://github.com/acme/widget.git")).toEqual({ host: "github", owner: "acme", repo: "widget" });
    expect(parseRemote("https://github.com/acme/widget")).toEqual({ host: "github", owner: "acme", repo: "widget" });
  });
  it("parses GitLab remotes, including subgroups", () => {
    expect(parseRemote("git@gitlab.com:grp/sub/proj.git")).toEqual({ host: "gitlab", owner: "grp/sub", repo: "proj" });
    expect(parseRemote("https://gitlab.example.com/grp/proj.git")).toEqual({ host: "gitlab", owner: "grp", repo: "proj" });
  });
  it("returns other for unknown hosts or unparseable urls", () => {
    expect(parseRemote("git@bitbucket.org:acme/widget.git").host).toBe("other");
    expect(parseRemote("not a url")).toEqual({ host: "other", owner: "", repo: "" });
  });
});

describe("compareUrl", () => {
  it("builds a GitHub compare URL", () => {
    expect(compareUrl({ host: "github", owner: "acme", repo: "widget" }, "main", "oawm/t-1-x"))
      .toBe("https://github.com/acme/widget/compare/main...oawm/t-1-x?expand=1");
  });
});
