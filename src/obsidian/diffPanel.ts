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

export class DiffModal extends Modal {
  constructor(app: App, private title: string, private diff: string) { super(app); }
  onOpen() {
    this.titleEl.setText(this.title);
    const pre = this.contentEl.createEl("pre", { cls: "oawm-diff" });
    for (const line of splitDiffLines(this.diff)) {
      pre.createEl("div", { cls: `oawm-diff-${line.kind}`, text: line.text || " " });
    }
  }
  onClose() { this.contentEl.empty(); }
}
