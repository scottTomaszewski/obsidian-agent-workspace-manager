import { Plugin } from "obsidian";
import type { TaskNote } from "../domain/types";

export type ActionId = "start" | "openTerminal" | "viewDiff" | "cancel" | "complete" | "restart";

function stateActions(task: TaskNote): ActionId[] {
  if (task.status === "Pending") return ["start"];
  if (task.status === "Cancelled" || task.status === "Completed") return ["start"];
  // status === "Running"
  switch (task.agentState) {
    // Waiting and NeedsReview both mean claude has paused/finished, so allow
    // Complete & Merge from either.
    case "Waiting":
    case "NeedsReview": return ["openTerminal", "viewDiff", "complete", "cancel"];
    case "Failed": return ["restart", "cancel"];
    case "Running": return ["openTerminal", "viewDiff", "cancel"];
    default: return ["openTerminal", "viewDiff", "cancel"];
  }
}

export function availableActions(task: TaskNote): ActionId[] {
  const actions = stateActions(task);
  // Whenever a session exists, always offer to (re)open its terminal — e.g. a
  // task marked Failed may still have a live session to reattach to.
  if (task.session && !actions.includes("openTerminal")) {
    return ["openTerminal", ...actions];
  }
  return actions;
}

export interface ActionBarDeps {
  getTaskByPath: (path: string) => Promise<TaskNote | null>;
  onAction: (action: ActionId, task: TaskNote) => Promise<void>;
}

const LABELS: Record<ActionId, string> = {
  start: "Start", openTerminal: "Open Terminal", viewDiff: "View Diff",
  cancel: "Cancel", complete: "Complete & Merge", restart: "Restart",
};

export function registerTaskCodeBlock(plugin: Plugin, deps: ActionBarDeps): void {
  plugin.registerMarkdownCodeBlockProcessor("oawm-task", async (_src, el, ctx) => {
    const path = ctx.sourcePath;
    const task = await deps.getTaskByPath(path);
    el.empty();
    if (!task) { el.createEl("em", { text: "OAWM: not a task note" }); return; }
    const bar = el.createDiv({ cls: "oawm-action-bar" });
    bar.createSpan({ cls: `oawm-badge oawm-${task.agentState || "idle"}`, text: task.agentState || "Idle" });
    for (const action of availableActions(task)) {
      const btn = bar.createEl("button", { text: LABELS[action] });
      btn.onclick = async () => {
        const fresh = await deps.getTaskByPath(path);
        if (fresh) await deps.onAction(action, fresh);
      };
    }
  });
}
