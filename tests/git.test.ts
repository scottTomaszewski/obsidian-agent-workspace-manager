import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGitBackend } from "../src/backends/git";
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

  it("diffs and merges a branch with a commit", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    writeFileSync(join(wt, "new.txt"), "content\n");
    await run("git", ["add", "."], { cwd: wt });
    await run("git", ["commit", "-m", "add new"], { cwd: wt });
    const diff = await git.diff(repo, "main", "oawm/x");
    expect(diff).toContain("new.txt");
    const merged = await git.merge(repo, "main", "oawm/x");
    expect(merged.ok).toBe(true);
    expect(existsSync(join(repo, "new.txt"))).toBe(true);
  });

  it("detects uncommitted work in a worktree", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    writeFileSync(join(wt, "dirty.txt"), "wip\n");
    expect(await git.hasUncommittedOrUnmerged(repo, "x", "main", "oawm/x")).toBe(true);
  });

  it("refuses to remove a dirty worktree without force", async () => {
    await git.createWorktree(repo, "oawm/x", "x", "main");
    const wt = join(repo, ".oawm-worktrees", "x");
    writeFileSync(join(wt, "dirty.txt"), "wip\n");
    const res = await git.removeWorktree(repo, "x", { force: false });
    expect(res.ok).toBe(false);
    expect(existsSync(wt)).toBe(true);
  });
});
