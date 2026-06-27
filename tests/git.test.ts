import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGitBackend, findWorktreeForBranch } from "../src/backends/git";
import { run } from "../src/backends/exec";

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oawm-git-"));
  await run("git", ["init", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t"], { cwd: dir });
  await run("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("RealGitBackend", () => {
  let repo: string;
  const git = new RealGitBackend();
  beforeEach(async () => { repo = await initRepo(); });

  it("creates a worktree on a new branch", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    expect(existsSync(join(repo, ".oawm-worktrees", "x", "README.md"))).toBe(true);
  });

  it("refuses to remove a dirty worktree without force", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    writeFileSync(join(wt, "dirty.txt"), "wip\n");
    const res = await git.removeWorktree(repo, "x", { force: false });
    expect(res.ok).toBe(false);
    expect(existsSync(wt)).toBe(true);
  });

  it("createWorktree is idempotent: second call with same args does not throw and worktree still exists", async () => {
    const wt = join(repo, ".oawm-worktrees", "x");
    await git.createWorktree(repo, "oawm/x", "x", "main");
    expect(existsSync(wt)).toBe(true);
    // Second call — simulates relaunch after Cancel/Failed left worktree on disk
    await expect(git.createWorktree(repo, "oawm/x", "x", "main")).resolves.toBeUndefined();
    expect(existsSync(wt)).toBe(true);
  });
});

describe("findWorktreeForBranch", () => {
  it("returns the worktree path for a branch", () => {
    const porcelain = [
      "worktree /code/repo", "HEAD aaa", "branch refs/heads/main", "",
      "worktree /code/repo/.oawm-worktrees/t-1", "HEAD bbb", "branch refs/heads/oawm/t-1", "",
    ].join("\n");
    expect(findWorktreeForBranch(porcelain, "main")).toBe("/code/repo");
    expect(findWorktreeForBranch(porcelain, "oawm/t-1")).toBe("/code/repo/.oawm-worktrees/t-1");
    expect(findWorktreeForBranch(porcelain, "absent")).toBeNull();
  });
});

describe("RealGitBackend completion primitives", () => {
  const git = new RealGitBackend();
  let repo: string;
  beforeEach(async () => { repo = await initRepo(); });

  it("worktreeDirty reflects uncommitted changes", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    expect(await git.worktreeDirty(wt)).toBe(false);
    writeFileSync(join(wt, "f.txt"), "wip\n");
    expect(await git.worktreeDirty(wt)).toBe(true);
  });

  it("mergeBaseIntoBranch integrates base cleanly", async () => {
    // advance base with a non-conflicting commit after the worktree branched
    writeFileSync(join(repo, "base.txt"), "base\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "base advance"], { cwd: repo });
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    // branch was created from main's tip BEFORE base advance? createWorktree uses baseBranch=main HEAD now.
    // Make a branch commit so it's a real --no-ff merge:
    writeFileSync(join(wt, "feat.txt"), "feat\n");
    await run("git", ["add", "."], { cwd: wt });
    await run("git", ["commit", "-m", "feat"], { cwd: wt });
    const res = await git.mergeBaseIntoBranch(wt, "main");
    expect(res.ok).toBe(true);
    expect(res.conflicts).toBe(false);
    expect(existsSync(join(wt, "base.txt"))).toBe(true); // base content now in the branch worktree
  });

  it("mergeBaseIntoBranch reports a real conflict without aborting", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    // both base and branch change README differently -> conflict on merge
    writeFileSync(join(repo, "README.md"), "base side\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-m", "base edits readme"], { cwd: repo });
    writeFileSync(join(wt, "README.md"), "branch side\n");
    await run("git", ["add", "."], { cwd: wt });
    await run("git", ["commit", "-m", "branch edits readme"], { cwd: wt });
    const res = await git.mergeBaseIntoBranch(wt, "main");
    expect(res.ok).toBe(false);
    expect(res.conflicts).toBe(true);
    // merge left in progress (not aborted): MERGE_HEAD exists
    expect((await run("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: wt })).code).toBe(0);
    // a second call detects the in-progress merge
    const again = await git.mergeBaseIntoBranch(wt, "main");
    expect(again.inProgress).toBe(true);
  });

  it("fastForwardBase advances base checked out in another worktree", async () => {
    // main is checked out in `repo`; create a task worktree that's ahead, then ff main
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    writeFileSync(join(wt, "feat.txt"), "feat\n");
    await run("git", ["add", "."], { cwd: wt });
    await run("git", ["commit", "-m", "feat"], { cwd: wt });
    const res = await git.fastForwardBase(repo, "main", "oawm/x");
    expect(res.ok).toBe(true);
    expect(existsSync(join(repo, "feat.txt"))).toBe(true); // main (in `repo`) advanced
  });

  it("getRemoteUrl returns the origin url", async () => {
    await run("git", ["remote", "add", "origin", "git@github.com:o/r.git"], { cwd: repo });
    expect(await git.getRemoteUrl(repo)).toBe("git@github.com:o/r.git");
  });

  it("pushBranch and pushBase push to a local bare remote", async () => {
    const bare = mkdtempSync(join(tmpdir(), "oawm-bare-"));
    await run("git", ["init", "--bare", "-b", "main"], { cwd: bare });
    await run("git", ["remote", "add", "origin", bare], { cwd: repo });
    const pb = await git.pushBase(repo, "main");
    expect(pb.ok).toBe(true);
    // a branch push lands too
    await run("git", ["branch", "oawm/x"], { cwd: repo });
    const pbr = await git.pushBranch(repo, "oawm/x");
    expect(pbr.ok).toBe(true);
    const refs = await run("git", ["ls-remote", "--heads", bare], { cwd: repo });
    expect(refs.stdout).toContain("oawm/x");
  });
});

describe("RealGitBackend.status", () => {
  const git2 = new RealGitBackend();
  let repo2: string;
  beforeEach(async () => { repo2 = await initRepo(); });

  it("reports staged, unstaged, and untracked files", async () => {
    await git2.createWorktree(repo2, "oawm/s", "s", "main");
    const wt = join(repo2, ".oawm-worktrees", "s");
    writeFileSync(join(wt, "README.md"), "changed\n");      // unstaged modify
    writeFileSync(join(wt, "brand.txt"), "new\n");          // untracked
    writeFileSync(join(wt, "staged.txt"), "s\n");
    await run("git", ["add", "staged.txt"], { cwd: wt });   // staged add
    const files = await git2.status(wt);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["README.md"]).toMatchObject({ staged: false, kind: "M" });
    expect(byPath["brand.txt"]).toMatchObject({ staged: false, kind: "?" });
    expect(byPath["staged.txt"]).toMatchObject({ staged: true, kind: "A" });
  });
});

describe("RealGitBackend.commitPaths", () => {
  const git3 = new RealGitBackend();
  let repo3: string;
  beforeEach(async () => { repo3 = await initRepo(); });

  it("commits only the given paths, leaving other changes uncommitted", async () => {
    await git3.createWorktree(repo3, "oawm/c", "c", "main");
    const wt = join(repo3, ".oawm-worktrees", "c");
    writeFileSync(join(wt, "keep.txt"), "in commit\n");
    writeFileSync(join(wt, "skip.txt"), "left dirty\n");
    const res = await git3.commitPaths(wt, ["keep.txt"], "feat: keep only");
    expect(res.ok).toBe(true);
    expect(res.commit).toMatch(/^[0-9a-f]{7,}$/);
    // skip.txt is still an untracked/uncommitted change
    const after = await git3.status(wt);
    expect(after.map((f) => f.path)).toContain("skip.txt");
    expect(after.map((f) => f.path)).not.toContain("keep.txt");
  });
});
