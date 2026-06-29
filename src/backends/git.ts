import { join } from "node:path";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import type { GitBackend } from "../core/ports";
import { run } from "./exec";
import { parseStatus, parseNameStatus } from "../core/changes";
import type { FileChange } from "../core/changes";

const WT_ROOT = ".oawm-worktrees";

export function findWorktreeForBranch(porcelain: string, branch: string): string | null {
  for (const block of porcelain.split(/\n\s*\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const br = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (path && br === branch) return path;
  }
  return null;
}

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

  async removeWorktree(repoPath: string, dir: string, opts: { force: boolean }) {
    const args = ["worktree", "remove", this.wtPath(repoPath, dir)];
    if (opts.force) args.push("--force");
    const res = await run("git", args, { cwd: repoPath });
    if (res.code !== 0) return { ok: false, reason: res.stderr };
    return { ok: true };
  }

  async mergeBaseIntoBranch(worktreePath: string, base: string): Promise<{ ok: boolean; conflicts: boolean; inProgress: boolean; message: string }> {
    const inProgress = (await run("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: worktreePath })).code === 0;
    if (inProgress) return { ok: false, conflicts: true, inProgress: true, message: "a merge is already in progress" };
    const res = await run("git", ["merge", "--no-ff", base], { cwd: worktreePath });
    const conflicts = /CONFLICT/i.test(res.stdout + res.stderr);
    if (res.code !== 0) return { ok: false, conflicts, inProgress: false, message: res.stdout + res.stderr };
    return { ok: true, conflicts: false, inProgress: false, message: res.stdout };
  }

  async worktreeDirty(worktreePath: string): Promise<boolean> {
    const res = await run("git", ["status", "--porcelain"], { cwd: worktreePath });
    return res.stdout.trim().length > 0;
  }

  async fastForwardBase(repoPath: string, base: string, branch: string): Promise<{ ok: boolean; reason?: string }> {
    const list = await run("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
    const baseWt = findWorktreeForBranch(list.stdout, base);
    if (baseWt) {
      const res = await run("git", ["merge", "--ff-only", branch], { cwd: baseWt });
      if (res.code !== 0) return { ok: false, reason: (res.stderr || res.stdout).trim() };
      return { ok: true };
    }
    const res = await run("git", ["branch", "-f", base, branch], { cwd: repoPath });
    if (res.code !== 0) return { ok: false, reason: res.stderr.trim() };
    return { ok: true };
  }

  async pushBranch(repoPath: string, branch: string, opts: { mrTarget?: string } = {}): Promise<{ ok: boolean; message: string }> {
    const args = ["push", "-u"];
    if (opts.mrTarget) args.push("-o", "merge_request.create", "-o", `merge_request.target=${opts.mrTarget}`);
    args.push("origin", branch);
    const res = await run("git", args, { cwd: repoPath });
    return { ok: res.code === 0, message: (res.stdout + res.stderr).trim() };
  }

  async pushBase(repoPath: string, base: string): Promise<{ ok: boolean; message: string }> {
    const res = await run("git", ["push", "origin", base], { cwd: repoPath });
    return { ok: res.code === 0, message: (res.stdout + res.stderr).trim() };
  }

  async getRemoteUrl(repoPath: string): Promise<string> {
    const res = await run("git", ["remote", "get-url", "origin"], { cwd: repoPath });
    return res.stdout.trim();
  }

  async status(worktreePath: string): Promise<FileChange[]> {
    const res = await run("git", ["status", "--porcelain"], { cwd: worktreePath });
    return parseStatus(res.stdout);
  }

  async commitPaths(worktreePath: string, paths: string[], message: string): Promise<{ ok: boolean; message: string; commit?: string }> {
    const add = await run("git", ["add", "--", ...paths], { cwd: worktreePath });
    if (add.code !== 0) return { ok: false, message: add.stderr.trim() };
    const res = await run("git", ["commit", "-m", message, "--", ...paths], { cwd: worktreePath });
    if (res.code !== 0) return { ok: false, message: (res.stdout + res.stderr).trim() };
    const sha = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: worktreePath });
    return { ok: true, message: res.stdout.trim(), commit: sha.stdout.trim() };
  }

  async branchDiffFiles(worktreePath: string, base: string): Promise<FileChange[]> {
    const res = await run("git", ["diff", "--name-status", `${base}...HEAD`], { cwd: worktreePath });
    return parseNameStatus(res.stdout);
  }

  async fileDiff(worktreePath: string, base: string, path: string, scope: "worktree" | "branch"): Promise<string> {
    if (scope === "branch") {
      return (await run("git", ["diff", `${base}...HEAD`, "--", path], { cwd: worktreePath })).stdout;
    }
    const tracked = (await run("git", ["ls-files", "--error-unmatch", "--", path], { cwd: worktreePath })).code === 0;
    if (tracked) return (await run("git", ["diff", "HEAD", "--", path], { cwd: worktreePath })).stdout;
    // Untracked: show whole-file as added (git exits 1 with --no-index when files differ).
    return (await run("git", ["diff", "--no-index", "--", "/dev/null", path], { cwd: worktreePath })).stdout;
  }

  async unmergedCounts(worktreePath: string, base: string): Promise<{ local: number; unmerged: number }> {
    const status = await run("git", ["status", "--porcelain"], { cwd: worktreePath });
    const local = status.stdout.split("\n").filter((l) => l.trim().length > 0).length;
    const rev = await run("git", ["rev-list", "--count", `${base}..HEAD`], { cwd: worktreePath });
    const unmerged = parseInt(rev.stdout.trim(), 10) || 0;
    return { local, unmerged };
  }

  async searchBranches(repoPath: string, query: string, limit: number): Promise<string[]> {
    const res = await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { cwd: repoPath });
    if (res.code !== 0) return [];
    const q = query.toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const ref of res.stdout.split("\n")) {
      const name = ref.trim();
      if (name.length === 0 || name.endsWith("/HEAD")) continue;
      if (!name.toLowerCase().includes(q)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= limit) break;
    }
    return out;
  }
}
