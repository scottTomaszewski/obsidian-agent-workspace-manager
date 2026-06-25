// Minimal stub for the obsidian package used in tests.
// The real obsidian package is types-only (main: ""), so Vite/Vitest cannot
// bundle it. This stub provides the runtime values needed by vaultGateway.ts and dashboardView.ts.

export class TFile {
  path: string = "";
  basename: string = "";
}

export class App {}

export class WorkspaceLeaf {}

export class ItemView {
  contentEl: HTMLElement = typeof document !== "undefined" ? document.createElement("div") : ({} as HTMLElement);
  constructor(_leaf: WorkspaceLeaf) {}
  getViewType(): string { return ""; }
  getDisplayText(): string { return ""; }
  getIcon(): string { return ""; }
  async onOpen(): Promise<void> {}
}
