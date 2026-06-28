import { ItemView, WorkspaceLeaf, App } from "obsidian";
import { splitDiffLines, buildSideBySide, SideCell, SideRow } from "./diffPanel";

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
    const wrap = bar.createDiv({ cls: "oawm-diff-tbgroup" });
    this.tbButton(wrap, "Wrap", this.prefs.wrap, () => this.setWrap(!this.prefs.wrap));
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

  private renderSideBySide(body: HTMLElement) {
    const rows = buildSideBySide(this.state.diff || "");
    if (this.prefs.wrap) this.renderSxsGrid(body, rows);
    else this.renderSxsPanes(body, rows);
  }

  // Wrap on: a single 4-column grid so each row's left/right cells share one row
  // track — wrapped lines stay vertically aligned. No horizontal scroll (lines wrap).
  private renderSxsGrid(body: HTMLElement, rows: SideRow[]) {
    const grid = body.createDiv({ cls: "oawm-diff-sxs" });
    if (rows.length === 0) { grid.createDiv({ cls: "oawm-diff-meta-row", text: "(no changes)" }); return; }
    for (const row of rows) {
      if (row.type === "meta") { grid.createDiv({ cls: "oawm-diff-meta-row", text: row.text || " " }); continue; }
      this.appendCell(grid, row.left);
      this.appendCell(grid, row.right);
    }
  }

  // Wrap off: two panes, each its own horizontal scroller, so a whole side scrolls
  // as one unit (not per line). Every row is one line tall, so left/right align by
  // having the same number of equal-height rows.
  private renderSxsPanes(body: HTMLElement, rows: SideRow[]) {
    const panes = body.createDiv({ cls: "oawm-diff-sxs-panes" });
    const left = panes.createDiv({ cls: "oawm-diff-pane" });
    const right = panes.createDiv({ cls: "oawm-diff-pane" });
    if (rows.length === 0) { left.createDiv({ cls: "oawm-diff-meta-row", text: "(no changes)" }); return; }
    for (const row of rows) {
      if (row.type === "meta") {
        left.createDiv({ cls: "oawm-diff-meta-row", text: row.text || " " });
        right.createDiv({ cls: "oawm-diff-meta-row", text: " " });
        continue;
      }
      this.appendCell(left.createDiv({ cls: "oawm-diff-srow" }), row.left);
      this.appendCell(right.createDiv({ cls: "oawm-diff-srow" }), row.right);
    }
    this.syncVerticalScroll(left, right);
  }

  // Each pane scrolls horizontally on its own, but their vertical scroll is mirrored so
  // a row stays at the same height on both sides. The value-equality guard stops the
  // ping-pong: once both scrollTops match, neither listener writes again.
  private syncVerticalScroll(a: HTMLElement, b: HTMLElement) {
    const link = (from: HTMLElement, to: HTMLElement) =>
      from.addEventListener("scroll", () => { if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop; });
    link(a, b);
    link(b, a);
  }

  // Append a line-number gutter + a text cell for one side into `parent`
  // (a grid container in wrap mode, a row div in pane mode).
  private appendCell(parent: HTMLElement, cell: SideCell | null) {
    if (!cell) {
      parent.createSpan({ cls: "oawm-diff-num" });
      parent.createSpan({ cls: "oawm-diff-cell oawm-diff-empty", text: " " });
      return;
    }
    parent.createSpan({ cls: "oawm-diff-num", text: String(cell.lineNo) });
    parent.createSpan({ cls: `oawm-diff-cell oawm-diff-${cell.kind}`, text: cell.text || " " });
  }
}

export type DiffTarget = "popout" | "split" | "tab";

/** Open (or reuse) a single diff leaf in a popout window, a main-area split, or a new tab. */
export async function openDiffLeaf(app: App, target: DiffTarget, state: DiffViewState): Promise<void> {
  const existing = app.workspace.getLeavesOfType(DIFF_VIEW_TYPE);
  const newLeaf = () =>
    target === "popout" ? app.workspace.openPopoutLeaf() : app.workspace.getLeaf(target === "tab" ? "tab" : "split");
  const leaf = existing[0] ?? newLeaf();
  await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });
  const view = leaf.view;
  if (view instanceof DiffView) view.setDiff(state);
  app.workspace.revealLeaf(leaf);
}
