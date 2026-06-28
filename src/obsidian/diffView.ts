import { ItemView, WorkspaceLeaf, App } from "obsidian";
import { splitDiffLines } from "./diffPanel";

export const DIFF_VIEW_TYPE = "oawm-diff";

export interface DiffViewState { title: string; diff: string }

export interface DiffPrefs { layout: "unified" | "sideBySide"; wrap: boolean }
export interface DiffPrefsGateway { get(): DiffPrefs; set(prefs: DiffPrefs): void | Promise<void> }

export class DiffView extends ItemView {
  private state: DiffViewState = { title: "Diff", diff: "" };
  private prefs: DiffPrefs;
  constructor(leaf: WorkspaceLeaf, private prefsGw: DiffPrefsGateway) {
    super(leaf);
    this.prefs = this.prefsGw.get();
  }
  getViewType() { return DIFF_VIEW_TYPE; }
  getDisplayText() { return this.state.title; }
  getIcon() { return "git-compare"; }

  setDiff(state: DiffViewState) { this.state = state; this.render(); }
  async onOpen() { this.prefs = this.prefsGw.get(); this.render(); }

  private setLayout(layout: DiffPrefs["layout"]) { this.prefs = { ...this.prefs, layout }; void this.prefsGw.set(this.prefs); this.render(); }
  private setWrap(wrap: boolean) { this.prefs = { ...this.prefs, wrap }; void this.prefsGw.set(this.prefs); this.render(); }

  private render() {
    const root = this.contentEl;
    root.empty();
    root.createEl("h4", { text: this.state.title });
    this.renderToolbar(root.createDiv({ cls: "oawm-diff-toolbar" }));
    const body = root.createDiv({ cls: "oawm-diff-body" });
    if (this.prefs.layout === "sideBySide") this.renderSideBySide(body);
    else this.renderUnified(body);
  }

  // One group per feature — future controls (ignore-whitespace, next/prev change)
  // append their own group here; nothing else in this file needs to change.
  private renderToolbar(bar: HTMLElement) {
    const layout = bar.createDiv({ cls: "oawm-diff-tbgroup" });
    this.tbButton(layout, "Unified", this.prefs.layout === "unified", () => this.setLayout("unified"));
    this.tbButton(layout, "Side-by-side", this.prefs.layout === "sideBySide", () => this.setLayout("sideBySide"));
    const view = bar.createDiv({ cls: "oawm-diff-tbgroup" });
    this.tbButton(view, "Wrap", this.prefs.wrap, () => this.setWrap(!this.prefs.wrap));
  }

  private tbButton(group: HTMLElement, label: string, active: boolean, onClick: () => void) {
    const b = group.createEl("button", { cls: "oawm-diff-tbbtn" + (active ? " oawm-tb-active" : ""), text: label });
    b.onclick = onClick;
    return b;
  }

  private renderUnified(body: HTMLElement) {
    const pre = body.createEl("pre", { cls: "oawm-diff" + (this.prefs.wrap ? " oawm-diff-wrap" : "") });
    for (const line of splitDiffLines(this.state.diff || "(no changes)")) {
      pre.createEl("div", { cls: `oawm-diff-${line.kind}`, text: line.text || " " });
    }
  }

  // Replaced by the real grid in Task 3. Until then, fall back to unified so the
  // body always renders something while the layout toggle is wired.
  private renderSideBySide(body: HTMLElement) {
    this.renderUnified(body);
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
