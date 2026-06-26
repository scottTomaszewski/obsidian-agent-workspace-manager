import { App, TFile } from "obsidian";
import { slugify } from "../domain/types";
import type { VaultGateway } from "../core/ports";
import type { TaskNote, WorkspaceNote, AgentNote, DesiredStatus, AgentState, Isolation } from "../domain/types";

type FM = Record<string, any>;

export function frontmatterToTask(path: string, basename: string, fm: FM): TaskNote {
  return {
    path,
    id: (fm.id as string) ?? slugify(basename),
    title: basename,
    workspace: fm.workspace ?? "",
    repositories: (fm.repositories as string[]) ?? [],
    agent: fm.agent ?? "",
    status: (fm.status as DesiredStatus) ?? "Pending",
    agentState: (fm.agent_state as AgentState) ?? "",
    worktree: fm.worktree ?? "",
    branch: fm.branch ?? "",
    session: fm.session ?? "",
  };
}

export function frontmatterToWorkspace(name: string, fm: FM): WorkspaceNote {
  return {
    name,
    repositories: (fm.repositories as { name: string; path: string }[]) ?? [],
    isolation: (fm.isolation as Isolation) ?? "worktree",
    baseBranch: fm.base_branch ?? "main",
    git: { user: fm.git?.user ?? "", email: fm.git?.email ?? "" },
    mux: { backend: "zellij" },
    host: { type: "local" },
    env: (fm.env as Record<string, string>) ?? {},
  };
}

export function frontmatterToAgent(name: string, fm: FM): AgentNote {
  return {
    name,
    provider: "claude",
    account: { configDir: fm.account?.config_dir ?? "" },
    command: fm.command ?? "claude",
    env: (fm.env as Record<string, string>) ?? {},
  };
}

const TASK_PATCH_KEYS: Record<keyof TaskNote, string> = {
  path: "", id: "id", title: "", workspace: "workspace", repositories: "repositories",
  agent: "agent", status: "status", agentState: "agent_state", worktree: "worktree",
  branch: "branch", session: "session",
};

/**
 * Extract the human-authored task body to seed the agent with: drop the YAML
 * frontmatter and any `oawm-task` action-bar code blocks, then trim.
 */
export function stripTaskBody(raw: string): string {
  return raw
    .replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") // leading frontmatter
    .replace(/```oawm-task[\s\S]*?```/g, "")               // action-bar blocks
    .trim();
}

export class ObsidianVaultGateway implements VaultGateway {
  constructor(private app: App) {}

  private filesOfType(type: string): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm?.type === type;
    });
  }

  async listTasks(): Promise<TaskNote[]> {
    return this.filesOfType("task").map((f) =>
      frontmatterToTask(f.path, f.basename, this.app.metadataCache.getFileCache(f)?.frontmatter ?? {}));
  }

  async getTask(path: string): Promise<TaskNote | null> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return null;
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
    return frontmatterToTask(f.path, f.basename, fm);
  }

  async getTaskBody(path: string): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return "";
    return stripTaskBody(await this.app.vault.cachedRead(f));
  }

  async patchTask(path: string, patch: Partial<TaskNote>): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(f, (fm: FM) => {
      for (const [k, v] of Object.entries(patch)) {
        const key = TASK_PATCH_KEYS[k as keyof TaskNote];
        if (key) fm[key] = v;
      }
    });
  }

  async getWorkspace(name: string): Promise<WorkspaceNote | null> {
    const f = this.filesOfType("workspace").find((x) => x.basename === name);
    if (!f) return null;
    return frontmatterToWorkspace(name, this.app.metadataCache.getFileCache(f)?.frontmatter ?? {});
  }

  async getAgent(name: string): Promise<AgentNote | null> {
    const f = this.filesOfType("agent").find((x) => x.basename === name);
    if (!f) return null;
    return frontmatterToAgent(name, this.app.metadataCache.getFileCache(f)?.frontmatter ?? {});
  }
}
