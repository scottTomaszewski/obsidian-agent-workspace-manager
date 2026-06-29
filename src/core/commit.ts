// src/core/commit.ts
import type { TaskNote } from "../domain/types";
import type { VaultGateway, GitBackend, Notifier } from "./ports";
import type { CheckoutTarget } from "./targets";
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
      results.push(await this.commitInCheckout(
        wt.path, wt.repo, repoPaths, input.message, input.push,
        () => this.deps.git.pushBranch(wt.path, wt.branch),
      ));
    }

    if (results.length === 0) this.deps.notifier.notice(`Task ${task.id}: nothing to commit`);
    else this.deps.notifier.notice(summarizeCommit(task.id, results));
    return results;
  }

  async commitTarget(target: CheckoutTarget, input: { paths: string[]; message: string; push: boolean }): Promise<RepoResult[]> {
    const pushFn = target.kind === "base"
      ? () => this.deps.git.pushBase(target.path, target.branch)
      : () => this.deps.git.pushBranch(target.path, target.branch);
    const result = await this.commitInCheckout(target.path, target.repo, input.paths, input.message, input.push, pushFn);
    this.deps.notifier.notice(summarizeCommit(target.taskId ?? target.repo, [result]));
    return [result];
  }

  private async commitInCheckout(
    path: string, repo: string, paths: string[], message: string, push: boolean,
    pushFn: () => Promise<{ ok: boolean; message: string }>,
  ): Promise<RepoResult> {
    const c = await this.deps.git.commitPaths(path, paths, message);
    if (!c.ok) return { repo, committed: false, pushed: false, error: c.message };
    if (!push) return { repo, committed: true, pushed: false, commit: c.commit };
    const pr = await pushFn();
    return { repo, committed: true, pushed: pr.ok, commit: c.commit, error: pr.ok ? undefined : pr.message };
  }
}
