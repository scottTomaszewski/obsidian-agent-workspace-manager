import type { TaskNote, WorkspaceNote, AgentNote } from "../domain/types";
import type { FileChange } from "./changes";

export interface VaultGateway {
  listTasks(): Promise<TaskNote[]>;
  getTask(path: string): Promise<TaskNote | null>;
  getTaskBody(path: string): Promise<string>;
  patchTask(path: string, patch: Partial<TaskNote>): Promise<void>;
  getWorkspace(name: string): Promise<WorkspaceNote | null>;
  getAgent(name: string): Promise<AgentNote | null>;
}

export interface GitBackend {
  createWorktree(repoPath: string, branch: string, dir: string, baseBranch: string): Promise<void>;
  diff(repoPath: string, baseBranch: string, branch: string): Promise<string>;
  removeWorktree(repoPath: string, dir: string, opts: { force: boolean }): Promise<{ ok: boolean; reason?: string }>;
  mergeBaseIntoBranch(worktreePath: string, base: string): Promise<{ ok: boolean; conflicts: boolean; inProgress: boolean; message: string }>;
  worktreeDirty(worktreePath: string): Promise<boolean>;
  fastForwardBase(repoPath: string, base: string, branch: string): Promise<{ ok: boolean; reason?: string }>;
  pushBranch(repoPath: string, branch: string, opts?: { mrTarget?: string }): Promise<{ ok: boolean; message: string }>;
  pushBase(repoPath: string, base: string): Promise<{ ok: boolean; message: string }>;
  getRemoteUrl(repoPath: string): Promise<string>;
  status(worktreePath: string): Promise<FileChange[]>;
  commitPaths(worktreePath: string, paths: string[], message: string): Promise<{ ok: boolean; message: string; commit?: string }>;
}

export interface MuxBackend {
  create(session: string, cwd: string, command: string, env: Record<string, string>): Promise<void>;
  kill(session: string): Promise<void>;
  focus(session: string): Promise<void>;
  isAlive(session: string): Promise<boolean>;
}

export interface LaunchArgs {
  task: TaskNote;
  cwd: string;
  agent: AgentNote;
  vaultRoot: string;
  prompt: string; // initial prompt to seed the agent with (task goal); "" for none
}

export interface AgentBackend {
  launch(args: LaunchArgs): Promise<{ session: string }>;
}

export interface Notifier {
  notice(msg: string): void;
  confirm(msg: string): Promise<boolean>;
}
