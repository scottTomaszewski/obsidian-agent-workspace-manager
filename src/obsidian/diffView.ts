import { ItemView, WorkspaceLeaf, App } from "obsidian";
import { splitDiffLines } from "./diffPanel";

export const DIFF_VIEW_TYPE = "oawm-diff";

export interface DiffViewState { title: string; diff: string }

export class DiffView extends ItemView {
  private state: DiffViewState = { title: "Diff", diff: "" };
  constructor(leaf: WorkspaceLeaf) { super(leaf); }
  getViewType() { return DIFF_VIEW_TYPE; }
  getDisplayText() { return this.state.title; }
  getIcon() { return "git-compare"; }

  setDiff(state: DiffViewState) { this.state = state; this.render(); }
  async onOpen() { this.render(); }

  private render() {
    const root = this.contentEl;
    root.empty();
    root.createEl("h4", { text: this.state.title });
    const pre = root.createEl("pre", { cls: "oawm-diff" });
    for (const line of splitDiffLines(this.state.diff || "(no changes)")) {
      pre.createEl("div", { cls: `oawm-diff-${line.kind}`, text: line.text || " " });
    }
  }
}

/** Open (or reuse) a single diff leaf in a popout window or a main-area split. */
export async function openDiffLeaf(app: App, target: "popout" | "split", state: DiffViewState): Promise<void> {
  const existing = app.workspace.getLeavesOfType(DIFF_VIEW_TYPE);
  const leaf = existing[0] ?? (target === "popout" ? app.workspace.openPopoutLeaf() : app.workspace.getLeaf("split"));
  await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });
  const view = leaf.view;
  if (view instanceof DiffView) view.setDiff(state);
  app.workspace.revealLeaf(leaf);
}
