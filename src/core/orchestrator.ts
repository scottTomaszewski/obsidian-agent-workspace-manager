import { decide } from "../domain/reconcile";
import { branchName, worktreeDirName } from "../domain/types";
import type { VaultGateway, GitBackend, MuxBackend, AgentBackend, Notifier } from "./ports";
import type { TaskNote, WorkspaceNote } from "../domain/types";

export interface OrchestratorDeps {
  vault: VaultGateway;
  git: GitBackend;
  mux: MuxBackend;
  agent: AgentBackend;
  notifier: Notifier;
  vaultRoot: string;
}

export class Orchestrator {
  private locks = new Map<string, Promise<void>>();
  constructor(private deps: OrchestratorDeps) {}

  reconcileTask(path: string): Promise<void> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.runReconcile(path));
    this.locks.set(path, next);
    return next;
  }

  private async runReconcile(path: string): Promise<void> {
    const task = await this.deps.vault.getTask(path);
    if (!task) return;
    const sessionAlive = task.session ? await this.deps.mux.isAlive(task.session) : false;
    const action = decide({ desired: task.status, actual: task.agentState, sessionAlive });
    switch (action) {
      case "launch": return this.launch(task);
      case "markFailed": return this.markFailed(task);
      case "killAndIdle": return this.killAndIdle(task);
      case "offerMerge": return this.completeAndMerge(task);
      case "none": return;
    }
  }

  private resolveRepoPath(task: TaskNote, ws: WorkspaceNote): string {
    const repoName = task.repositories[0];
    const repo = ws.repositories.find((r) => r.name === repoName) ?? ws.repositories[0];
    return repo.path;
  }

  private async launch(task: TaskNote): Promise<void> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    const agent = await this.deps.vault.getAgent(task.agent);
    if (!ws || !agent) {
      await this.deps.vault.patchTask(task.path, { agentState: "Failed" });
      this.deps.notifier.notice(`Task ${task.id}: missing workspace or agent`);
      return;
    }
    const repoPath = this.resolveRepoPath(task, ws);
    const branch = branchName(task.id, task.title);
    const dir = worktreeDirName(task.id, task.title);
    let cwd = repoPath;
    if (ws.isolation === "worktree") {
      await this.deps.git.createWorktree(repoPath, branch, dir, ws.baseBranch);
      cwd = `${repoPath}/.oawm-worktrees/${dir}`;
    }
    const { session } = await this.deps.agent.launch({ task, cwd, agent, vaultRoot: this.deps.vaultRoot });
    await this.deps.vault.patchTask(task.path, {
      agentState: "Running", branch, worktree: cwd, session,
    });
    this.deps.notifier.notice(`Task ${task.id}: agent running`);
  }

  private async markFailed(task: TaskNote): Promise<void> {
    await this.deps.vault.patchTask(task.path, { agentState: "Failed" });
    this.deps.notifier.notice(`Task ${task.id}: session ended unexpectedly`);
  }

  private async killAndIdle(task: TaskNote): Promise<void> {
    if (task.session) await this.deps.mux.kill(task.session);
    await this.deps.vault.patchTask(task.path, { agentState: "Idle" });
  }

  private async completeAndMerge(task: TaskNote): Promise<void> {
    if (task.agentState === "Idle") return;
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws || ws.isolation !== "worktree" || !task.branch) {
      // repo-direct or missing branch: finalize without merging
      if (task.session) await this.deps.mux.kill(task.session);
      await this.deps.vault.patchTask(task.path, { agentState: "Idle", session: "", branch: "" });
      return;
    }
    const repoPath = this.resolveRepoPath(task, ws);
    const dir = worktreeDirName(task.id, task.title);
    const res = await this.deps.git.merge(repoPath, ws.baseBranch, task.branch);
    if (!res.ok || res.conflicts) {
      await this.deps.vault.patchTask(task.path, { agentState: "NeedsReview", status: "Running" });
      this.deps.notifier.notice(`Task ${task.id}: merge conflict, resolve in terminal`);
      return;
    }
    const dirty = await this.deps.git.hasUncommittedOrUnmerged(repoPath, dir, ws.baseBranch, task.branch);
    if (dirty) {
      const ok = await this.deps.notifier.confirm(`Task ${task.id}: worktree has unsaved work. Discard and remove?`);
      if (!ok) {
        // Merge already happened; finalize but keep the worktree
        if (task.session) await this.deps.mux.kill(task.session);
        await this.deps.vault.patchTask(task.path, { agentState: "Idle", session: "", branch: "" });
        this.deps.notifier.notice(`Task ${task.id}: merged into ${ws.baseBranch}, worktree kept`);
        return;
      }
    }
    if (task.session) await this.deps.mux.kill(task.session);
    await this.deps.git.removeWorktree(repoPath, dir, { force: dirty });
    await this.deps.vault.patchTask(task.path, { agentState: "Idle", session: "", worktree: "", branch: "" });
    this.deps.notifier.notice(`Task ${task.id}: merged into ${ws.baseBranch}`);
  }
}
