import { join } from "node:path";
import type { GitBackend } from "../core/ports";
import { run } from "./exec";

const WT_ROOT = ".oawm-worktrees";

export class RealGitBackend implements GitBackend {
  private wtPath(repoPath: string, dir: string) { return join(repoPath, WT_ROOT, dir); }

  async createWorktree(repoPath: string, branch: string, dir: string, baseBranch: string): Promise<void> {
    const res = await run("git", ["worktree", "add", "-b", branch, this.wtPath(repoPath, dir), baseBranch], { cwd: repoPath });
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr}`);
  }

  async diff(repoPath: string, baseBranch: string, branch: string): Promise<string> {
    const res = await run("git", ["diff", `${baseBranch}...${branch}`], { cwd: repoPath });
    return res.stdout;
  }

  async merge(repoPath: string, baseBranch: string, branch: string) {
    const co = await run("git", ["checkout", baseBranch], { cwd: repoPath });
    if (co.code !== 0) return { ok: false, conflicts: false, message: co.stderr };
    const res = await run("git", ["merge", "--no-ff", branch], { cwd: repoPath });
    const conflicts = /CONFLICT/i.test(res.stdout + res.stderr);
    if (res.code !== 0) {
      if (conflicts) await run("git", ["merge", "--abort"], { cwd: repoPath });
      return { ok: false, conflicts, message: res.stdout + res.stderr };
    }
    return { ok: true, conflicts: false, message: res.stdout };
  }

  async hasUncommittedOrUnmerged(repoPath: string, dir: string, baseBranch: string, branch: string): Promise<boolean> {
    const wt = this.wtPath(repoPath, dir);
    const status = await run("git", ["status", "--porcelain"], { cwd: wt });
    if (status.stdout.trim().length > 0) return true;
    const unmerged = await run("git", ["log", `${baseBranch}..${branch}`, "--oneline"], { cwd: repoPath });
    return unmerged.stdout.trim().length > 0;
  }

  async removeWorktree(repoPath: string, dir: string, opts: { force: boolean }) {
    const args = ["worktree", "remove", this.wtPath(repoPath, dir)];
    if (opts.force) args.push("--force");
    const res = await run("git", args, { cwd: repoPath });
    if (res.code !== 0) return { ok: false, reason: res.stderr };
    return { ok: true };
  }
}
