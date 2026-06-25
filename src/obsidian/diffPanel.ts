import { App, Modal } from "obsidian";

export type DiffKind = "add" | "del" | "meta" | "ctx";
export function splitDiffLines(diff: string): { text: string; kind: DiffKind }[] {
  return diff.split("\n").map((text) => {
    let kind: DiffKind = "ctx";
    if (text.startsWith("diff ") || text.startsWith("@@") || text.startsWith("index ") ||
        text.startsWith("--- ") || text.startsWith("+++ ")) kind = "meta";
    else if (text.startsWith("+")) kind = "add";
    else if (text.startsWith("-")) kind = "del";
    return { text, kind };
  });
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
