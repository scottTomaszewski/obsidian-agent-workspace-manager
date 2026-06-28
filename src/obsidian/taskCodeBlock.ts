import { Plugin } from "obsidian";
import type { TaskNote } from "../domain/types";

export type ActionId = "start" | "openTerminal" | "viewDiff" | "merge" | "mergePush" | "push" | "openPr" | "cancel" | "restart";

const GIT_ACTIONS: ActionId[] = ["merge", "mergePush", "push", "openPr"];

function stateActions(task: TaskNote): ActionId[] {
  if (task.status === "Pending") return ["start"];
  if (task.status === "Cancelled" || task.status === "Completed") return ["start"];
  // status === "Running"
  if (task.agentState === "Failed") return ["restart", "cancel"];
  // Running / Waiting / NeedsReview / "" → active
  const git = task.branch ? GIT_ACTIONS : [];
  return ["openTerminal", "viewDiff", ...git, "cancel"];
}

export function availableActions(task: TaskNote): ActionId[] {
  const actions = stateActions(task);
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
  start: "Start", openTerminal: "Open Terminal", viewDiff: "Review Changes",
  merge: "Merge", mergePush: "Merge & Push", push: "Push", openPr: "Open PR/MR",
  cancel: "Cancel", restart: "Restart",
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
