export type DesiredStatus = "Pending" | "Running" | "Completed" | "Cancelled";
export type AgentState = "" | "Idle" | "Running" | "Waiting" | "NeedsReview" | "Failed";
export type Isolation = "worktree" | "repo-direct";

export interface TaskNote {
  path: string;          // vault-relative note path (identity within the vault)
  id: string;            // stable task id, e.g. "DS-123"
  title: string;         // note basename, used for slug
  workspace: string;     // workspace note name
  repositories: string[];
  agent: string;         // agent note name
  status: DesiredStatus;
  agentState: AgentState;
  worktree: string;
  branch: string;
  session: string;
}

export interface WorkspaceNote {
  name: string;
  repositories: { name: string; path: string }[];
  isolation: Isolation;
  baseBranch: string;
  git: { user: string; email: string };
  mux: { backend: "zellij" };
  host: { type: "local" };
  env: Record<string, string>;
}

export interface AgentNote {
  name: string;
  provider: "claude";
  account: { configDir: string };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function worktreeDirName(id: string, title: string): string {
  return `${slugify(id)}-${slugify(title)}`;
}

export function branchName(id: string, title: string): string {
  return `oawm/${worktreeDirName(id, title)}`;
}
