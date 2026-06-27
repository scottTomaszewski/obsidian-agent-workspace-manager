import type { VaultGateway, GitBackend, MuxBackend, AgentBackend, Notifier, LaunchArgs } from "../src/core/ports";
import type { TaskNote, WorkspaceNote, AgentNote } from "../src/domain/types";

const baseTask: TaskNote = {
  path: "", id: "", title: "", workspace: "W", repositories: ["repo"],
  agent: "vexa", status: "Pending", agentState: "", worktree: "", branch: "", session: "",
};

export class FakeVault implements VaultGateway {
  tasks = new Map<string, TaskNote>();
  bodies = new Map<string, string>();
  workspaces = new Map<string, WorkspaceNote>();
  agents = new Map<string, AgentNote>();
  seedTask(t: Partial<TaskNote> & { path: string }) {
    this.tasks.set(t.path, { ...baseTask, ...t });
  }
  async listTasks() { return [...this.tasks.values()]; }
  async getTask(p: string) { return this.tasks.get(p) ?? null; }
  async getTaskBody(p: string) { return this.bodies.get(p) ?? ""; }
  async patchTask(p: string, patch: Partial<TaskNote>) {
    const cur = this.tasks.get(p);
    if (cur) this.tasks.set(p, { ...cur, ...patch });
  }
  async getWorkspace(n: string) { return this.workspaces.get(n) ?? null; }
  async getAgent(n: string) { return this.agents.get(n) ?? null; }
}

export class FakeGit implements GitBackend {
  worktrees = new Set<string>();
  removeCalls: { dir: string; force: boolean }[] = [];
  integratedBase: string[] = [];
  fastForwarded: { base: string; branch: string }[] = [];
  pushedBranches: { branch: string; mrTarget?: string }[] = [];
  pushedBases: string[] = [];
  dirty = false;
  statusFiles: import("../src/core/changes").FileChange[] = [];
  commitCalls: { worktree: string; paths: string[]; message: string }[] = [];
  failCommitWorktrees = new Set<string>();
  conflicts = false;
  inProgress = false;
  ffOk = true;
  pushBranchOk = true;
  pushBaseOk = true;
  remoteUrl = "git@github.com:acme/widget.git";

  async createWorktree(_r: string, _b: string, dir: string) { this.worktrees.add(dir); }
  async diff() { return "diff --git a b"; }
  async removeWorktree(_r: string, dir: string, opts: { force: boolean }) {
    this.removeCalls.push({ dir, force: opts.force });
    if (this.dirty && !opts.force) return { ok: false, reason: "dirty" };
    this.worktrees.delete(dir);
    return { ok: true };
  }
  async mergeBaseIntoBranch(_wt: string, base: string) {
    this.integratedBase.push(base);
    return { ok: !this.conflicts && !this.inProgress, conflicts: this.conflicts, inProgress: this.inProgress, message: "" };
  }
  async worktreeDirty() { return this.dirty; }
  async status() { return this.statusFiles; }
  async commitPaths(worktree: string, paths: string[], message: string) {
    this.commitCalls.push({ worktree, paths, message });
    if (this.failCommitWorktrees.has(worktree)) return { ok: false, message: "commit failed" };
    return { ok: true, message: "", commit: "abc1234" };
  }
  async fastForwardBase(_r: string, base: string, branch: string) {
    this.fastForwarded.push({ base, branch });
    return this.ffOk ? { ok: true } : { ok: false, reason: "blocked" };
  }
  async pushBranch(_r: string, branch: string, opts: { mrTarget?: string } = {}) {
    this.pushedBranches.push({ branch, mrTarget: opts.mrTarget });
    return { ok: this.pushBranchOk, message: "" };
  }
  async pushBase(_r: string, base: string) {
    this.pushedBases.push(base);
    return { ok: this.pushBaseOk, message: "" };
  }
  async getRemoteUrl(_r: string) { return this.remoteUrl; }
}

export class FakeMux implements MuxBackend {
  alive = new Set<string>();
  creates: { session: string; cwd: string; command: string; env: Record<string, string> }[] = [];
  async create(session: string, cwd: string, command: string, env: Record<string, string>) {
    this.creates.push({ session, cwd, command, env });
    this.alive.add(session);
  }
  async kill(session: string) { this.alive.delete(session); }
  async focus() {}
  async isAlive(session: string) { return this.alive.has(session); }
}

export class FakeAgent implements AgentBackend {
  launches: LaunchArgs[] = [];
  mux?: FakeMux;
  async launch(args: LaunchArgs) {
    this.launches.push(args);
    const session = `oawm-${args.task.id}`;
    if (this.mux) await this.mux.create(session, args.cwd, "claude", {});
    return { session };
  }
}

export class FakeNotifier implements Notifier {
  notices: string[] = [];
  confirmAnswer = true;
  notice(m: string) { this.notices.push(m); }
  async confirm() { return this.confirmAnswer; }
}
