import { worktreeDirName } from "../domain/types";
import type { TaskNote, WorkspaceNote } from "../domain/types";
import type { VaultGateway, GitBackend, MuxBackend, Notifier } from "./ports";
import { parseRemote, compareUrl } from "./remote";

export interface CompletionDeps {
  vault: VaultGateway;
  git: GitBackend;
  mux: MuxBackend;
  notifier: Notifier;
}

function resolveRepoPath(task: TaskNote, ws: WorkspaceNote): string {
  const repo = ws.repositories.find((r) => r.name === task.repositories[0]) ?? ws.repositories[0];
  return repo.path;
}

const PUSH_DIRTY_WARNING = "worktree has uncommitted changes — only committed work will be pushed; uncommitted changes stay in the worktree. Continue?";

export class CompletionCoordinator {
  constructor(private deps: CompletionDeps) {}

  async merge(task: TaskNote, opts: { push: boolean }): Promise<void> {
    if (task.agentState === "Idle") return; // already completed
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) return;

    // repo-direct or missing branch/worktree: finalize without merging
    if (ws.isolation !== "worktree" || !task.branch || !task.worktree) {
      if (task.session) await this.deps.mux.kill(task.session);
      await this.deps.vault.patchTask(task.path, { status: "Completed", agentState: "Idle", session: "", branch: "", worktree: "" });
      return;
    }

    const repoPath = resolveRepoPath(task, ws);

    // Uncommitted check — finishing action discards on teardown, so confirm.
    let force = false;
    if (await this.deps.git.worktreeDirty(task.worktree)) {
      const ok = await this.deps.notifier.confirm(
        `Task ${task.id}: worktree has uncommitted changes that will be discarded when the worktree is removed after merge. Merge committed work and discard the rest?`,
      );
      if (!ok) return;
      force = true;
    }

    // Integrate base into the task branch (conflicts surface in the worktree).
    const integ = await this.deps.git.mergeBaseIntoBranch(task.worktree, ws.baseBranch);
    if (!integ.ok) {
      await this.deps.vault.patchTask(task.path, { agentState: "NeedsReview" });
      this.deps.notifier.notice(
        integ.inProgress
          ? `Task ${task.id}: finish resolving and commit the in-progress merge in the task terminal, then retry.`
          : `Task ${task.id}: merge conflict — resolve in the task terminal (Open Terminal), then click Merge again.`,
      );
      return;
    }

    // Advance base (guaranteed fast-forward).
    const ff = await this.deps.git.fastForwardBase(repoPath, ws.baseBranch, task.branch);
    if (!ff.ok) {
      await this.deps.vault.patchTask(task.path, { agentState: "NeedsReview" });
      this.deps.notifier.notice(`Task ${task.id}: could not fast-forward ${ws.baseBranch} (${ff.reason ?? "blocked"}). Resolve and retry.`);
      return;
    }

    if (opts.push) {
      const pushed = await this.deps.git.pushBase(repoPath, ws.baseBranch);
      if (!pushed.ok) this.deps.notifier.notice(`Task ${task.id}: merged locally but push failed: ${pushed.message}`);
    }

    if (task.session) await this.deps.mux.kill(task.session);
    await this.deps.git.removeWorktree(repoPath, worktreeDirName(task.id, task.title), { force });
    await this.deps.vault.patchTask(task.path, { status: "Completed", agentState: "Idle", session: "", branch: "", worktree: "" });
    this.deps.notifier.notice(opts.push ? `Task ${task.id}: merged into ${ws.baseBranch} and pushed` : `Task ${task.id}: merged into ${ws.baseBranch}`);
  }

  async pushBranch(task: TaskNote): Promise<void> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws || !task.branch) { this.deps.notifier.notice(`Task ${task.id}: no branch to push`); return; }
    if (!(await this.confirmPushIfDirty(task))) return;
    const res = await this.deps.git.pushBranch(resolveRepoPath(task, ws), task.branch);
    this.deps.notifier.notice(res.ok ? `Task ${task.id}: pushed ${task.branch}` : `Task ${task.id}: push failed: ${res.message}`);
  }

  async openPr(task: TaskNote): Promise<{ url?: string }> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws || !task.branch) { this.deps.notifier.notice(`Task ${task.id}: no branch for PR`); return {}; }
    if (!(await this.confirmPushIfDirty(task))) return {};
    const repoPath = resolveRepoPath(task, ws);
    const remote = parseRemote(await this.deps.git.getRemoteUrl(repoPath));

    if (remote.host === "gitlab") {
      const res = await this.deps.git.pushBranch(repoPath, task.branch, { mrTarget: ws.baseBranch });
      this.deps.notifier.notice(res.ok ? `Task ${task.id}: pushed ${task.branch} and requested MR` : `Task ${task.id}: push failed: ${res.message}`);
      return {};
    }

    const res = await this.deps.git.pushBranch(repoPath, task.branch);
    if (!res.ok) { this.deps.notifier.notice(`Task ${task.id}: push failed: ${res.message}`); return {}; }
    if (remote.host === "github") return { url: compareUrl(remote, ws.baseBranch, task.branch) };
    this.deps.notifier.notice(`Task ${task.id}: pushed ${task.branch} (open a PR/MR on your host)`);
    return {};
  }

  private async confirmPushIfDirty(task: TaskNote): Promise<boolean> {
    if (!task.worktree) return true;
    if (!(await this.deps.git.worktreeDirty(task.worktree))) return true;
    return this.deps.notifier.confirm(`Task ${task.id}: ${PUSH_DIRTY_WARNING}`);
  }
}
