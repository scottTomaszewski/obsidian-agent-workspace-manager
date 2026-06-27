import { join } from "node:path";
import { branchName, worktreeDirName } from "../domain/types";
import type { TaskNote, WorkspaceNote } from "../domain/types";

export interface TaskWorktree {
  repo: string;
  path: string;
  branch: string;
}

export function resolveTaskWorktrees(task: TaskNote, ws: WorkspaceNote): TaskWorktree[] {
  const dir = worktreeDirName(task.id, task.title);
  const branch = branchName(task.id, task.title);
  const names = task.repositories.length > 0 ? task.repositories : ws.repositories.map((r) => r.name);
  return names.map((name) => {
    const repo = ws.repositories.find((r) => r.name === name) ?? ws.repositories[0];
    const path = ws.isolation === "worktree" ? join(repo.path, ".oawm-worktrees", dir) : repo.path;
    return { repo: name, path, branch };
  });
}
