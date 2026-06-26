import { join } from "node:path";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import type { GitBackend } from "../core/ports";
import { run } from "./exec";

const WT_ROOT = ".oawm-worktrees";

export class RealGitBackend implements GitBackend {
  private wtPath(repoPath: string, dir: string) { return join(repoPath, WT_ROOT, dir); }

  async createWorktree(repoPath: string, branch: string, dir: string, baseBranch: string): Promise<void> {
    const wtDir = this.wtPath(repoPath, dir);

    // Idempotent relaunch: if the worktree dir already exists, reuse it.
    if (existsSync(wtDir)) return;

    // Check whether the branch already exists (e.g. dir was manually removed).
    const branchCheck = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath });
    let res;
    if (branchCheck.code === 0) {
      // Branch exists — attach without -b
      res = await run("git", ["worktree", "add", wtDir, branch], { cwd: repoPath });
    } else {
      // New branch
      res = await run("git", ["worktree", "add", "-b", branch, wtDir, baseBranch], { cwd: repoPath });
    }
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr}`);

    // Best-effort: keep .oawm paths out of the user's tracked files.
    try {
      const excludePath = join(repoPath, ".git", "info", "exclude");
      const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
      const toAdd: string[] = [];
      if (!existing.includes(".oawm-worktrees/")) toAdd.push(".oawm-worktrees/");
      if (!existing.includes(".oawm/")) toAdd.push(".oawm/");
      if (toAdd.length > 0) appendFileSync(excludePath, "\n" + toAdd.join("\n") + "\n");
    } catch { /* best-effort: never fail worktree creation */ }
  }

  async diff(repoPath: string, baseBranch: string, branch: string): Promise<string> {
    const res = await run("git", ["diff", `${baseBranch}...${branch}`], { cwd: repoPath });
    let output = res.stdout;
    // Append untracked files (spec: "plus untracked").
    const untracked = await run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoPath });
    if (untracked.stdout.trim()) {
      output += "\nUntracked files:\n" + untracked.stdout.trim().split("\n").map((f) => `  ${f}`).join("\n") + "\n";
    }
    return output;
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

  async mergeBaseIntoBranch(): Promise<{ ok: boolean; conflicts: boolean; inProgress: boolean; message: string }> {
    throw new Error("Not implemented");
  }

  async worktreeDirty(): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async fastForwardBase(): Promise<{ ok: boolean; reason?: string }> {
    throw new Error("Not implemented");
  }

  async pushBranch(): Promise<{ ok: boolean; message: string }> {
    throw new Error("Not implemented");
  }

  async pushBase(): Promise<{ ok: boolean; message: string }> {
    throw new Error("Not implemented");
  }

  async getRemoteUrl(): Promise<string> {
    throw new Error("Not implemented");
  }
}
