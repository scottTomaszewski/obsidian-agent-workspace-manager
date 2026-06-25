import { Plugin, TFile, Notice, WorkspaceLeaf, normalizePath } from "obsidian";
import { join } from "node:path";
import { mkdirSync, watch as fsWatch, readFileSync } from "node:fs";
import { ObsidianVaultGateway } from "./obsidian/vaultGateway";
import { RealGitBackend } from "./backends/git";
import { ZellijBackend } from "./backends/zellij";
import { ClaudeBackend } from "./backends/claude";
import { Orchestrator } from "./core/orchestrator";
import { StatusIngest } from "./core/statusIngest";
import { registerTaskCodeBlock, ActionId } from "./obsidian/taskCodeBlock";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./obsidian/dashboardView";
import { DiffModal } from "./obsidian/diffPanel";
import type { TaskNote } from "./domain/types";

export default class OawmPlugin extends Plugin {
  private orchestrator!: Orchestrator;
  private vault!: ObsidianVaultGateway;
  private git!: RealGitBackend;
  private mux!: ZellijBackend;
  private statusDir!: string;
  private sweepTimer?: number;
  private fsWatcher?: ReturnType<typeof fsWatch>;

  async onload() {
    const vaultRoot = (this.app.vault.adapter as any).getBasePath?.() ?? "";
    this.statusDir = join(vaultRoot, ".oawm", "status");
    const hookHelperPath = join(vaultRoot, this.manifest.dir ?? "", "oawm-hook.mjs");

    this.vault = new ObsidianVaultGateway(this.app);
    this.git = new RealGitBackend();
    this.mux = new ZellijBackend();
    const notifier = { notice: (m: string) => new Notice(`OAWM: ${m}`), confirm: async (m: string) => confirm(m) };
    const agent = new ClaudeBackend({ mux: this.mux, hookHelperPath, statusDir: this.statusDir });
    this.orchestrator = new Orchestrator({ vault: this.vault, git: this.git, mux: this.mux, agent, notifier, vaultRoot });

    const ingest = new StatusIngest({ vault: this.vault, reconcile: (p) => this.orchestrator.reconcileTask(p) });

    // Action bar
    registerTaskCodeBlock(this, {
      getTaskByPath: (p) => this.vault.getTask(p),
      onAction: (action, task) => this.handleAction(action, task),
    });

    // Dashboard view
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
      new DashboardView(leaf, this.vault, (path) => this.openTask(path)));
    this.addRibbonIcon("bot", "Agent Workspace", () => this.activateDashboard());
    this.addCommand({ id: "open-dashboard", name: "Open Agent Workspace", callback: () => this.activateDashboard() });

    // Reconcile on task-note edits
    this.registerEvent(this.app.metadataCache.on("changed", (file: TFile) => {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.type === "task") void this.orchestrator.reconcileTask(file.path);
    }));

    // Ensure status dir exists before attaching watcher
    try {
      mkdirSync(this.statusDir, { recursive: true });
    } catch {
      new Notice("OAWM: could not create status dir");
    }

    // Watch status markers
    this.startStatusWatcher(ingest);

    // Liveness sweep every 15s
    this.sweepTimer = window.setInterval(() => void this.sweep(), 15000);
    this.registerInterval(this.sweepTimer);
  }

  onunload() { this.fsWatcher?.close(); }

  private startStatusWatcher(ingest: StatusIngest) {
    try {
      this.fsWatcher = fsWatch(this.statusDir, (_e, filename) => {
        if (!filename || !filename.endsWith(".json")) return;
        const id = filename.replace(/\.json$/, "");
        try { void ingest.ingest(id, readFileSync(join(this.statusDir, filename), "utf8")); } catch { /* mid-write */ }
      });
    } catch { /* catches an fsWatch OS error; status dir was created in onload */ }
  }

  private async sweep() {
    for (const task of await this.vault.listTasks()) {
      if (task.status === "Running") void this.orchestrator.reconcileTask(task.path);
    }
  }

  private async handleAction(action: ActionId, task: TaskNote) {
    switch (action) {
      case "start": await this.vault.patchTask(task.path, { status: "Running" }); break;
      case "cancel": await this.vault.patchTask(task.path, { status: "Cancelled" }); break;
      case "complete": await this.vault.patchTask(task.path, { status: "Completed" }); break;
      case "restart": await this.vault.patchTask(task.path, { agentState: "", status: "Running" }); break;
      case "openTerminal": if (task.session) await this.mux.focus(task.session); return;
      case "viewDiff": await this.showDiff(task); return;
    }
    await this.orchestrator.reconcileTask(task.path);
  }

  private async showDiff(task: TaskNote) {
    const ws = await this.vault.getWorkspace(task.workspace);
    if (!ws || !task.branch) { new Notice("OAWM: no branch to diff"); return; }
    const repo = ws.repositories.find((r) => r.name === task.repositories[0]) ?? ws.repositories[0];
    const diff = await this.git.diff(repo.path, ws.baseBranch, task.branch);
    new DiffModal(this.app, `${task.id} diff`, diff || "(no changes)").open();
  }

  private async openTask(path: string) {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (f instanceof TFile) await this.app.workspace.getLeaf(true).openFile(f);
  }

  private async activateDashboard() {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) { new Notice("OAWM: could not open dashboard"); return; }
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
