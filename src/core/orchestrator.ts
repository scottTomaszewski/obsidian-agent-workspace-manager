import { decide } from "../domain/reconcile";
import { branchName, worktreeDirName } from "../domain/types";
import type { VaultGateway, GitBackend, MuxBackend, AgentBackend, Notifier } from "./ports";
import type { TaskNote, WorkspaceNote } from "../domain/types";
import type { CompletionCoordinator } from "./completion";

export interface OrchestratorDeps {
  vault: VaultGateway;
  git: GitBackend;
  mux: MuxBackend;
  agent: AgentBackend;
  notifier: Notifier;
  vaultRoot: string;
  completion: CompletionCoordinator;
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
    const prompt = await this.deps.vault.getTaskBody(task.path);
    const { session } = await this.deps.agent.launch({ task, cwd, agent, vaultRoot: this.deps.vaultRoot, prompt });
    // The terminal/zellij startup is async: agent.launch resolves when the
    // terminal spawns, before zellij has registered the session. Wait for the
    // session to actually appear so we don't write Running and then immediately
    // race a liveness check into Failed.
    const alive = await this.waitForSession(session);
    await this.deps.vault.patchTask(task.path, {
      agentState: alive ? "Running" : "Failed", branch, worktree: cwd, session,
    });
    this.deps.notifier.notice(
      alive ? `Task ${task.id}: agent running` : `Task ${task.id}: session did not start`,
    );
  }

  private async waitForSession(session: string): Promise<boolean> {
    const deadline = Date.now() + 8000;
    for (;;) {
      if (await this.deps.mux.isAlive(session)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async markFailed(task: TaskNote): Promise<void> {
    await this.deps.vault.patchTask(task.path, { agentState: "Failed" });
    this.deps.notifier.notice(`Task ${task.id}: session ended unexpectedly`);
  }

  private async killAndIdle(task: TaskNote): Promise<void> {
    if (task.session) await this.deps.mux.kill(task.session);
    await this.deps.vault.patchTask(task.path, { agentState: "Idle", session: "", branch: "", worktree: "" });
  }

  private async completeAndMerge(task: TaskNote): Promise<void> {
    await this.deps.completion.merge(task, { push: false });
  }
}
