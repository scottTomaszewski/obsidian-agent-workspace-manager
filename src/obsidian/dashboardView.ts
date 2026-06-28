import { ItemView, WorkspaceLeaf } from "obsidian";
import type { TaskNote, AgentState } from "../domain/types";
import type { VaultGateway } from "../core/ports";

export const DASHBOARD_VIEW_TYPE = "oawm-dashboard";
type DisplayState = "Pending" | "Waiting" | "NeedsReview" | "Running" | "Failed" | "Idle";
const ORDER: DisplayState[] = ["Waiting", "NeedsReview", "Running", "Pending", "Failed", "Idle"];

function displayState(task: TaskNote): DisplayState {
  if (task.status === "Pending") return "Pending";
  const s = task.agentState;
  if (s === "Waiting" || s === "NeedsReview" || s === "Running" || s === "Failed") return s;
  return "Idle";
}

export function groupByState(tasks: TaskNote[]): Record<DisplayState, TaskNote[]> {
  const groups = Object.fromEntries(ORDER.map((s) => [s, [] as TaskNote[]])) as Record<DisplayState, TaskNote[]>;
  for (const t of tasks) groups[displayState(t)].push(t);
  return groups;
}

export class DashboardView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private vault: VaultGateway,
    private openTask: (path: string) => void,
    private onReview: (path: string) => void,
  ) {
    super(leaf);
  }
  getViewType() { return DASHBOARD_VIEW_TYPE; }
  getDisplayText() { return "Agent Workspace"; }
  getIcon() { return "bot"; }

  async onOpen() { await this.render(); }
  async render() {
    const root = this.contentEl;
    root.empty();
    root.createEl("h3", { text: "Agent Workspace" });
    const groups = groupByState(await this.vault.listTasks());
    for (const state of ORDER) {
      const tasks = groups[state];
      if (tasks.length === 0) continue;
      root.createEl("h4", { text: `${state} (${tasks.length})` });
      for (const task of tasks) {
        const row = root.createDiv({ cls: "oawm-dash-row" });
        const link = row.createEl("a", { text: `${task.id} — ${task.title}`, href: "#" });
        link.onclick = (e) => { e.preventDefault(); this.openTask(task.path); };
        row.createSpan({ cls: "oawm-dash-agent", text: ` @${task.agent}` });
        if (task.branch && task.worktree) {
          const review = row.createEl("a", { text: " Review", href: "#", cls: "oawm-dash-review" });
          review.onclick = (e) => { e.preventDefault(); this.onReview(task.path); };
        }
      }
    }
  }
}
