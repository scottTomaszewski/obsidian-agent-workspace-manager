// src/core/commit.ts
import type { TaskNote } from "../domain/types";
import type { VaultGateway, GitBackend, Notifier } from "./ports";
import { resolveTaskWorktrees } from "./worktrees";

export interface CommitDeps {
  vault: VaultGateway;
  git: GitBackend;
  notifier: Notifier;
}

export interface CommitInput {
  paths: { repo: string; path: string }[];
  message: string;
  push: boolean;
}

export interface RepoResult {
  repo: string;
  committed: boolean;
  pushed: boolean;
  commit?: string;
  error?: string;
}

export function summarizeCommit(taskId: string, results: RepoResult[]): string {
  const parts = results.map((r) => {
    if (!r.committed) return `${r.repo}: commit failed — ${r.error ?? "unknown"}`;
    if (r.error) return `${r.repo}: committed ${r.commit ?? ""}, push failed — ${r.error}`;
    return `${r.repo}: committed ${r.commit ?? ""}${r.pushed ? ", pushed" : ""}`;
  });
  return `Task ${taskId}: ${parts.join(" · ")}`;
}

export class CommitCoordinator {
  constructor(private deps: CommitDeps) {}

  async commit(task: TaskNote, input: CommitInput): Promise<RepoResult[]> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) { this.deps.notifier.notice(`Task ${task.id}: missing workspace`); return []; }

    const byRepo = new Map<string, string[]>();
    for (const p of input.paths) {
      const arr = byRepo.get(p.repo) ?? [];
      arr.push(p.path);
      byRepo.set(p.repo, arr);
    }

    const results: RepoResult[] = [];
    for (const wt of resolveTaskWorktrees(task, ws)) {
      const repoPaths = byRepo.get(wt.repo);
      if (!repoPaths || repoPaths.length === 0) continue;

      const c = await this.deps.git.commitPaths(wt.path, repoPaths, input.message);
      if (!c.ok) { results.push({ repo: wt.repo, committed: false, pushed: false, error: c.message }); continue; }

      if (!input.push) { results.push({ repo: wt.repo, committed: true, pushed: false, commit: c.commit }); continue; }

      const pr = await this.deps.git.pushBranch(wt.path, wt.branch);
      results.push({ repo: wt.repo, committed: true, pushed: pr.ok, commit: c.commit, error: pr.ok ? undefined : pr.message });
    }

    if (results.length === 0) this.deps.notifier.notice(`Task ${task.id}: nothing to commit`);
    else this.deps.notifier.notice(summarizeCommit(task.id, results));
    return results;
  }
}
