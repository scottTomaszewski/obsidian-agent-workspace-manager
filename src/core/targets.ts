import type { TaskNote, WorkspaceNote } from "../domain/types";
import { resolveTaskWorktrees } from "./worktrees";

export interface CheckoutTarget {
  repo: string;          // repo name
  repoPath: string;      // repo root path; the per-repo base-ref pin key
  path: string;          // checkout dir (= repoPath for base checkouts)
  branch: string;
  kind: "base" | "worktree";
  defaultBaseRef: string;
  taskPath?: string;
  taskId?: string;
  taskTitle?: string;
  session?: string;
}

/** Group every checkout (each repo's base checkout + each task worktree) by repo name. */
export function buildTargets(tasks: TaskNote[], workspaces: WorkspaceNote[]): Map<string, CheckoutTarget[]> {
  const groups = new Map<string, CheckoutTarget[]>();
  const seenBase = new Set<string>(); // repo paths already given a base target
  const ensure = (repo: string): CheckoutTarget[] => {
    let arr = groups.get(repo);
    if (!arr) { arr = []; groups.set(repo, arr); }
    return arr;
  };

  for (const ws of workspaces) {
    for (const repo of ws.repositories) {
      if (seenBase.has(repo.path)) continue;
      seenBase.add(repo.path);
      ensure(repo.name).push({
        repo: repo.name, repoPath: repo.path, path: repo.path,
        branch: ws.baseBranch, kind: "base", defaultBaseRef: `origin/${ws.baseBranch}`,
      });
    }
  }

  for (const task of tasks) {
    if (!task.branch || !task.worktree) continue;
    const ws = workspaces.find((w) => w.name === task.workspace);
    if (!ws) continue;
    for (const wt of resolveTaskWorktrees(task, ws)) {
      const repoPath = ws.repositories.find((r) => r.name === wt.repo)?.path ?? wt.path;
      ensure(wt.repo).push({
        repo: wt.repo, repoPath, path: wt.path, branch: wt.branch, kind: "worktree",
        defaultBaseRef: ws.baseBranch, taskPath: task.path, taskId: task.id,
        taskTitle: task.title, session: task.session || undefined,
      });
    }
  }
  return groups;
}

/** Pinned base ref (keyed by repo path) wins over the target's default. */
export function resolveBaseRef(target: CheckoutTarget, pinned: Record<string, string>): string {
  return pinned[target.repoPath] ?? target.defaultBaseRef;
}
