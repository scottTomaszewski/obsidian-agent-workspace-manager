import type { VaultGateway, GitBackend, MuxBackend, AgentBackend, Notifier, LaunchArgs } from "../src/core/ports";
import type { TaskNote, WorkspaceNote, AgentNote } from "../src/domain/types";

const baseTask: TaskNote = {
  path: "", id: "", title: "", workspace: "W", repositories: ["repo"],
  agent: "vexa", status: "Pending", agentState: "", worktree: "", branch: "", session: "",
};

export class FakeVault implements VaultGateway {
  tasks = new Map<string, TaskNote>();
  workspaces = new Map<string, WorkspaceNote>();
  agents = new Map<string, AgentNote>();
  seedTask(t: Partial<TaskNote> & { path: string }) {
    this.tasks.set(t.path, { ...baseTask, ...t });
  }
  async listTasks() { return [...this.tasks.values()]; }
  async getTask(p: string) { return this.tasks.get(p) ?? null; }
  async patchTask(p: string, patch: Partial<TaskNote>) {
    const cur = this.tasks.get(p);
    if (cur) this.tasks.set(p, { ...cur, ...patch });
  }
  async getWorkspace(n: string) { return this.workspaces.get(n) ?? null; }
  async getAgent(n: string) { return this.agents.get(n) ?? null; }
}

export class FakeGit implements GitBackend {
  worktrees = new Set<string>();
  merged: string[] = [];
  dirty = false;
  async createWorktree(_r: string, _b: string, dir: string) { this.worktrees.add(dir); }
  async diff() { return "diff --git a b"; }
  async merge(_r: string, _base: string, branch: string) {
    this.merged.push(branch);
    return { ok: true, conflicts: false, message: "merged" };
  }
  async removeWorktree(_r: string, dir: string, opts: { force: boolean }) {
    if (this.dirty && !opts.force) return { ok: false, reason: "dirty" };
    this.worktrees.delete(dir);
    return { ok: true };
  }
  async hasUncommittedOrUnmerged() { return this.dirty; }
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
