# Diff View: Wrap/Scroll + Side-by-Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `DiffView` a scalable toolbar with a unified/side-by-side layout toggle and a line-wrap toggle, with both preferences persisted in plugin settings.

**Architecture:** Keep diff *parsing* pure and unit-tested in `src/obsidian/diffPanel.ts` (a new `buildSideBySide` model alongside the existing `splitDiffLines`). The `DiffView` ItemView (no node tests, per project convention) renders either a unified `<pre>` or a 4-column CSS grid, reads/writes its two prefs through a small `DiffPrefsGateway` wired to plugin settings in `main.ts`, and grows a `.oawm-diff-toolbar` whose control groups are added one-per-feature so future standard diff controls (ignore-whitespace, next/prev change) slot in without restructuring.

**Tech Stack:** TypeScript, Obsidian plugin API (`ItemView`), Vitest, plain CSS (`styles.css`). No new dependencies.

## Global Constraints

- Desktop-only Obsidian plugin; raw `git` only (no `gh`/`glab`). (Not exercised here, but the layering rules apply.)
- **Layering:** pure decision logic lives in `src/obsidian/diffPanel.ts` (matching where `splitDiffLines` already lives) and is unit-tested; `ItemView` DOM stays thin and has **no** node tests — it gets manual-test coverage instead.
- **Done gate (run after every code task):** `npm run typecheck` clean + `npm test` green + `npm run build` emits `main.js`.
- **TDD:** for `diffPanel.ts` work, write the failing test first.
- **Defaults (decided with the user):** default layout = **side-by-side**; default wrap = **off** (long lines scroll horizontally; toggle to soft-wrap). Both prefs **persist in settings** so the next diff opens in the last-used mode.
- **Scalable toolbar:** we implement only the layout and wrap controls now, but the toolbar must be structured so adding another control = adding one more group/button in `renderToolbar`, nothing else.
- **Out of scope:** the legacy unused `DiffModal` in `diffPanel.ts` (dead code, no importers) — leave it untouched. No settings-tab UI for these prefs; the toolbar is the only control surface (it writes through to settings for persistence).

---

### Task 1: Pure side-by-side diff model in `diffPanel.ts`

Extract the line-classifier so it can be shared, then add `buildSideBySide`, which parses a unified diff string into aligned left/right rows with line numbers. This is the only unit-tested task.

**Files:**
- Modify: `src/obsidian/diffPanel.ts`
- Test: `tests/diffFormat.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function classifyDiffLine(text: string): DiffKind` — existing classification logic, now reusable.
  - `export interface SideCell { lineNo: number; text: string; kind: "ctx" | "add" | "del" }` — `text` has the leading `+`/`-`/space marker stripped (the column conveys add/del).
  - `export type SideRow = { type: "meta"; text: string } | { type: "line"; left: SideCell | null; right: SideCell | null }`
  - `export function buildSideBySide(diff: string): SideRow[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/diffFormat.test.ts`:

```typescript
import { classifyDiffLine, buildSideBySide } from "../src/obsidian/diffPanel";

describe("classifyDiffLine", () => {
  it("classifies the diff marker lines", () => {
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("meta");
    expect(classifyDiffLine("--- a/x")).toBe("meta");
    expect(classifyDiffLine("+++ b/x")).toBe("meta");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine(" context")).toBe("ctx");
  });
});

describe("buildSideBySide", () => {
  it("pairs changed lines and numbers context from the hunk header", () => {
    const rows = buildSideBySide([
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
    ].join("\n"));
    expect(rows.map((r) => r.type)).toEqual(["meta", "line", "line", "line"]);
    expect(rows[1]).toEqual({
      type: "line",
      left: { lineNo: 1, text: "a", kind: "ctx" },
      right: { lineNo: 1, text: "a", kind: "ctx" },
    });
    expect(rows[2]).toEqual({
      type: "line",
      left: { lineNo: 2, text: "b", kind: "del" },
      right: { lineNo: 2, text: "B", kind: "add" },
    });
    expect(rows[3].type === "line" && rows[3].right).toEqual({ lineNo: 3, text: "c", kind: "ctx" });
  });

  it("leaves the right cell null for a pure deletion", () => {
    const rows = buildSideBySide(["@@ -1,2 +1,1 @@", " a", "-b"].join("\n"));
    expect(rows[2]).toEqual({
      type: "line",
      left: { lineNo: 2, text: "b", kind: "del" },
      right: null,
    });
  });

  it("leaves the left cell null for a pure addition", () => {
    const rows = buildSideBySide(["@@ -1,1 +1,2 @@", " a", "+b"].join("\n"));
    expect(rows[2]).toEqual({
      type: "line",
      left: null,
      right: { lineNo: 2, text: "b", kind: "add" },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/diffFormat.test.ts`
Expected: FAIL — `classifyDiffLine`/`buildSideBySide` are not exported.

- [ ] **Step 3: Implement the shared classifier and the model**

Replace the top of `src/obsidian/diffPanel.ts` (the `DiffKind` type + `splitDiffLines`) with:

```typescript
import { App, Modal } from "obsidian";

export type DiffKind = "add" | "del" | "meta" | "ctx";

export function classifyDiffLine(text: string): DiffKind {
  if (text.startsWith("diff ") || text.startsWith("@@") || text.startsWith("index ") ||
      text.startsWith("--- ") || text.startsWith("+++ ")) return "meta";
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  return "ctx";
}

export function splitDiffLines(diff: string): { text: string; kind: DiffKind }[] {
  return diff.split("\n").map((text) => ({ text, kind: classifyDiffLine(text) }));
}

export interface SideCell { lineNo: number; text: string; kind: "ctx" | "add" | "del" }
export type SideRow =
  | { type: "meta"; text: string }
  | { type: "line"; left: SideCell | null; right: SideCell | null };

/**
 * Parse a unified diff into aligned side-by-side rows. Deletions land on the
 * left, additions on the right; a run of `-`/`+` lines inside a hunk is zipped
 * row-by-row (the shorter side gets `null` cells). Context lines flush any
 * pending run, then occupy both columns. Line numbers seed from the `@@` header.
 */
export function buildSideBySide(diff: string): SideRow[] {
  const rows: SideRow[] = [];
  let oldNo = 0, newNo = 0;
  let dels: SideCell[] = [], adds: SideCell[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ type: "line", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = []; adds = [];
  };
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { flush(); oldNo = Number(hunk[1]); newNo = Number(hunk[2]); rows.push({ type: "meta", text }); continue; }
    const kind = classifyDiffLine(text);
    if (kind === "meta") { flush(); rows.push({ type: "meta", text }); continue; }
    if (text.startsWith("\\")) continue;            // "\ No newline at end of file"
    if (kind === "add") { adds.push({ lineNo: newNo++, text: text.slice(1), kind: "add" }); continue; }
    if (kind === "del") { dels.push({ lineNo: oldNo++, text: text.slice(1), kind: "del" }); continue; }
    if (text === "") continue;                       // trailing split("\n") artifact
    flush();
    rows.push({ type: "line",
      left: { lineNo: oldNo++, text: text.slice(1), kind: "ctx" },
      right: { lineNo: newNo++, text: text.slice(1), kind: "ctx" } });
  }
  flush();
  return rows;
}
```

Leave the existing `DiffModal` class below this block exactly as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/diffFormat.test.ts`
Expected: PASS (all `splitDiffLines`, `classifyDiffLine`, and `buildSideBySide` cases).

- [ ] **Step 5: Run the done gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests green, `main.js` emitted.

- [ ] **Step 6: Commit**

```bash
git add src/obsidian/diffPanel.ts tests/diffFormat.test.ts
git commit -m "feat(diff): add side-by-side diff model + shared line classifier"
```

---

### Task 2: Toolbar, wrap toggle, and persisted prefs

Add the prefs gateway, wire it to two new settings, and give `DiffView` a scalable toolbar plus the unified-mode wrap toggle. Side-by-side still renders as the unified `<pre>` here (a fallback) — Task 3 replaces that branch — so the toggle's active state changes but the body only differs once Task 3 lands. Manual-test wrap in **Unified** mode.

**Files:**
- Modify: `src/obsidian/diffView.ts`
- Modify: `src/main.ts:21-35` (settings interface + defaults) and `src/main.ts:84` (view registration)
- Modify: `styles.css:10` (diff styles)

**Interfaces:**
- Consumes: `splitDiffLines` from `diffPanel.ts`.
- Produces:
  - `export interface DiffPrefs { layout: "unified" | "sideBySide"; wrap: boolean }`
  - `export interface DiffPrefsGateway { get(): DiffPrefs; set(prefs: DiffPrefs): void | Promise<void> }`
  - `DiffView` constructor signature becomes `constructor(leaf: WorkspaceLeaf, prefsGw: DiffPrefsGateway)`.

- [ ] **Step 1: Add the two settings + defaults**

In `src/main.ts`, extend the `OawmSettings` interface (currently lines 21-27) by adding two fields after `diffTarget`:

```typescript
  diffTarget: "popout" | "split";
  diffLayout: "unified" | "sideBySide";
  diffWrap: boolean;
```

And extend `DEFAULT_SETTINGS` (currently lines 29-35) after `diffTarget`:

```typescript
  diffTarget: "popout",
  diffLayout: "sideBySide",
  diffWrap: false,
```

- [ ] **Step 2: Rewrite `diffView.ts` with the toolbar + prefs gateway**

Replace the entire contents of `src/obsidian/diffView.ts` with:

```typescript
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
```

- [ ] **Step 3: Wire the prefs gateway into view registration**

In `src/main.ts`, update the import on line 15 to pull in the gateway type:

```typescript
import { DiffView, DIFF_VIEW_TYPE, openDiffLeaf, DiffPrefsGateway } from "./obsidian/diffView";
```

Replace the diff-view registration (currently `src/main.ts:84`):

```typescript
    this.registerView(DIFF_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DiffView(leaf));
```

with:

```typescript
    const diffPrefs: DiffPrefsGateway = {
      get: () => ({ layout: this.settings.diffLayout, wrap: this.settings.diffWrap }),
      set: async (p) => {
        this.settings.diffLayout = p.layout;
        this.settings.diffWrap = p.wrap;
        await this.saveData(this.settings);
      },
    };
    this.registerView(DIFF_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DiffView(leaf, diffPrefs));
```

- [ ] **Step 4: Add toolbar + wrap CSS**

In `styles.css`, replace the single `.oawm-diff` rule on line 10:

```css
.oawm-diff { font-family: var(--font-monospace); font-size: 12px; white-space: pre; overflow-x: auto; }
```

with:

```css
.oawm-diff { font-family: var(--font-monospace); font-size: 12px; white-space: pre; overflow-x: auto; }
.oawm-diff.oawm-diff-wrap { white-space: pre-wrap; word-break: break-word; overflow-x: hidden; }
.oawm-diff-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 4px 0 8px; }
.oawm-diff-tbgroup { display: inline-flex; gap: 2px; }
.oawm-diff-tbbtn { padding: 2px 8px; font-size: 12px; }
.oawm-diff-tbbtn.oawm-tb-active { font-weight: 700; background: var(--interactive-accent); color: var(--text-on-accent); }
```

- [ ] **Step 5: Run the done gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, tests green, `main.js` emitted.

- [ ] **Step 6: Manual smoke test**

Reload the plugin in Obsidian (copy `main.js`/`styles.css` into the vault's plugin dir, toggle the plugin off/on). Open a file diff from the Changes panel and verify:
- [ ] A toolbar shows `Unified | Side-by-side` and `Wrap`, with **Side-by-side** highlighted (the new default) and **Wrap** off.
- [ ] Click **Unified** — a long diff line overflows with a horizontal scrollbar.
- [ ] Click **Wrap** — the long line soft-wraps and the horizontal scrollbar disappears; click again to restore scroll.
- [ ] Close and reopen the diff (or reload the plugin) — the toolbar comes back in the last-used layout/wrap state (persisted).

- [ ] **Step 7: Commit**

```bash
git add src/obsidian/diffView.ts src/main.ts styles.css
git commit -m "feat(diff): scalable toolbar + persisted wrap/layout prefs"
```

---

### Task 3: Side-by-side rendering

Replace the `renderSideBySide` fallback with the real 4-column grid built from `buildSideBySide`, plus its CSS (including the wrap-vs-scroll column sizing).

**Files:**
- Modify: `src/obsidian/diffView.ts` (import + `renderSideBySide` + a `renderCell` helper)
- Modify: `styles.css` (append the grid rules)

**Interfaces:**
- Consumes: `buildSideBySide`, `SideCell`, `SideRow` from `diffPanel.ts` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Import the model**

In `src/obsidian/diffView.ts`, update the `diffPanel` import:

```typescript
import { splitDiffLines, buildSideBySide, SideCell } from "./diffPanel";
```

- [ ] **Step 2: Implement the real side-by-side render**

In `src/obsidian/diffView.ts`, replace the placeholder `renderSideBySide`:

```typescript
  // Replaced by the real grid in Task 3. Until then, fall back to unified so the
  // body always renders something while the layout toggle is wired.
  private renderSideBySide(body: HTMLElement) {
    this.renderUnified(body);
  }
```

with:

```typescript
  private renderSideBySide(body: HTMLElement) {
    const grid = body.createDiv({ cls: "oawm-diff-sxs" + (this.prefs.wrap ? " oawm-diff-wrap" : "") });
    const rows = buildSideBySide(this.state.diff || "");
    if (rows.length === 0) { grid.createDiv({ cls: "oawm-diff-meta-row", text: "(no changes)" }); return; }
    for (const row of rows) {
      if (row.type === "meta") { grid.createDiv({ cls: "oawm-diff-meta-row", text: row.text || " " }); continue; }
      this.renderCell(grid, row.left);
      this.renderCell(grid, row.right);
    }
  }

  private renderCell(grid: HTMLElement, cell: SideCell | null) {
    if (!cell) {
      grid.createDiv({ cls: "oawm-diff-num" });
      grid.createDiv({ cls: "oawm-diff-cell oawm-diff-empty" });
      return;
    }
    grid.createDiv({ cls: "oawm-diff-num", text: String(cell.lineNo) });
    grid.createDiv({ cls: `oawm-diff-cell oawm-diff-${cell.kind}`, text: cell.text || " " });
  }
```

- [ ] **Step 3: Add side-by-side CSS**

Append to `styles.css`:

```css
/* Side-by-side diff: [old# | old text | new# | new text]. max-content columns let
   the grid exceed the viewport so the container scrolls horizontally when not wrapping;
   minmax(0,1fr) columns let cells soft-wrap when Wrap is on. */
.oawm-diff-sxs { display: grid; grid-template-columns: auto max-content auto max-content;
  column-gap: 8px; font-family: var(--font-monospace); font-size: 12px; overflow-x: auto; }
.oawm-diff-sxs.oawm-diff-wrap { grid-template-columns: auto minmax(0,1fr) auto minmax(0,1fr); overflow-x: hidden; }
.oawm-diff-num { text-align: right; color: var(--text-muted); user-select: none; padding: 0 4px; }
.oawm-diff-cell { white-space: pre; }
.oawm-diff-sxs.oawm-diff-wrap .oawm-diff-cell { white-space: pre-wrap; word-break: break-word; }
.oawm-diff-cell.oawm-diff-add { background: rgba(0, 200, 83, 0.10); color: var(--color-green); }
.oawm-diff-cell.oawm-diff-del { background: rgba(255, 0, 0, 0.10); color: var(--color-red); }
.oawm-diff-meta-row { grid-column: 1 / -1; color: var(--text-muted); white-space: pre; margin-top: 4px; }
```

- [ ] **Step 4: Run the done gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, tests green, `main.js` emitted.

- [ ] **Step 5: Manual test**

Reload the plugin, open a file diff, and verify in **Side-by-side** layout:
- [ ] Two aligned columns: old lines (with old line numbers) left, new lines (with new line numbers) right.
- [ ] Changed lines show the deletion on the left (red tint) and the addition on the right (green tint); a pure delete leaves the right cell blank, a pure add leaves the left blank.
- [ ] Hunk headers (`@@ …`) span the full width as muted meta rows.
- [ ] With **Wrap** off, a long line makes the whole grid scroll horizontally; with **Wrap** on, cells wrap and columns stay within the viewport.
- [ ] Toggling to **Unified** and back preserves the same diff content.

- [ ] **Step 6: Commit**

```bash
git add src/obsidian/diffView.ts styles.css
git commit -m "feat(diff): render side-by-side two-column layout"
```

---

### Task 4: Doc sync

Keep the canonical docs true per the project's sync agreement.

**Files:**
- Modify: `ARCHITECTURE.md:95-96`
- Modify: `docs/gotchas.md`
- Modify: `docs/MANUAL-TEST.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the ARCHITECTURE module map**

In `ARCHITECTURE.md`, replace lines 95-96:

```markdown
- `obsidian/diffView.ts` — `DiffView` ItemView + `openDiffLeaf` (popout/split, single reused leaf).
- `obsidian/diffPanel.ts` — `splitDiffLines` diff formatting (+ legacy `DiffModal`).
```

with:

```markdown
- `obsidian/diffView.ts` — `DiffView` ItemView + `openDiffLeaf` (popout/split, single reused leaf).
  Scalable toolbar with unified/side-by-side layout + line-wrap toggles, persisted via a
  `DiffPrefsGateway` wired to the `diffLayout`/`diffWrap` settings in `main.ts`.
- `obsidian/diffPanel.ts` — diff parsing: `classifyDiffLine`, `splitDiffLines` (unified),
  and `buildSideBySide` (two-column model). (+ legacy unused `DiffModal`.)
```

- [ ] **Step 2: Add a gotcha for the side-by-side pairing + wrap CSS**

Append to `docs/gotchas.md`:

```markdown
## Side-by-side diff is derived from the unified diff string, not a second git call

`buildSideBySide` (`src/obsidian/diffPanel.ts`) reconstructs two columns from the same
unified diff the unified view uses — there is no separate `git diff` invocation. Within a
hunk it buffers consecutive `-` lines (left) and `+` lines (right) and zips them row-by-row
on the next context line or hunk boundary (`flush()`); the shorter side gets `null` cells.
Line numbers seed from the `@@ -old +new @@` header. Two non-obvious skips: lines starting
with `\` (the "No newline at end of file" marker) and a trailing empty string from
`split("\n")` are dropped so they don't create phantom rows or mis-number columns.

The side-by-side grid uses **two** `grid-template-columns` sets on purpose: `max-content`
text columns (so the grid overflows and the container scrolls horizontally when Wrap is off)
vs. `minmax(0,1fr)` columns (so cells can `pre-wrap` when Wrap is on). The `.oawm-diff-wrap`
class on the container switches between them — see `styles.css`.
```

- [ ] **Step 3: Update the manual checklist**

In `docs/MANUAL-TEST.md`, replace step 5:

```markdown
5. Click **View Diff** → modal shows colored diff of the branch.
```

with:

```markdown
5. Click **View Diff** → a popout/split diff leaf opens (per the "Diff window" setting) with a
   toolbar: `Unified | Side-by-side` + `Wrap`.
   - [ ] Default layout is **Side-by-side** (two aligned columns with old/new line numbers;
         deletions tinted red on the left, additions green on the right).
   - [ ] **Wrap** off → long lines scroll horizontally; **Wrap** on → lines soft-wrap.
   - [ ] **Unified** shows the single-column colored diff; toggling back to Side-by-side keeps content.
   - [ ] Close + reopen the diff (or reload the plugin) → it returns in the last-used layout/wrap state.
```

- [ ] **Step 4: Add a CHANGELOG entry**

In `CHANGELOG.md`, under `## Unreleased`, add a bullet:

```markdown
- The diff view gained a toolbar with a **side-by-side** layout (now the default) alongside the
  unified view, plus a **line-wrap** toggle (vs. horizontal scroll). Both preferences persist.
```

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md docs/gotchas.md docs/MANUAL-TEST.md CHANGELOG.md
git commit -m "docs: side-by-side + wrap diff view (architecture, gotchas, manual test, changelog)"
```

---

## Self-Review

**Spec coverage:**
- Horizontal scrolling / line wrapping → Task 2 (wrap toggle + `.oawm-diff-wrap` CSS; base `.oawm-diff` already scrolls). ✅
- Side-by-side view → Task 1 (model) + Task 3 (render). ✅
- "Prepare the UI to be scalable" (user note) → Task 2 `renderToolbar` is one-group-per-feature with an inline comment marking where future controls attach. ✅
- Persist prefs in settings → Task 2 (`diffLayout`/`diffWrap` + `DiffPrefsGateway`). ✅
- Default side-by-side → Task 2 `DEFAULT_SETTINGS`. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — every code step shows full code. The Task 2 `renderSideBySide` fallback is intentional and explicitly replaced in Task 3 (called out in both tasks). ✅

**Type consistency:** `DiffPrefs`/`DiffPrefsGateway` defined in Task 2 and consumed verbatim in `main.ts`; `SideCell`/`SideRow`/`buildSideBySide`/`classifyDiffLine` defined in Task 1 and imported in Task 3 with matching names and shapes; settings keys `diffLayout`/`diffWrap` identical across `main.ts` and the gateway. `tbButton`/`renderToolbar`/`renderCell`/`renderUnified`/`renderSideBySide`/`setLayout`/`setWrap` names are consistent within `diffView.ts`. ✅
