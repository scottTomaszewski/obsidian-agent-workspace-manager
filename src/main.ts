import { Plugin, TFile, Notice, WorkspaceLeaf, normalizePath, PluginSettingTab, Setting, App } from "obsidian";
import { join } from "node:path";
import { mkdirSync, watch as fsWatch, readFileSync, writeFileSync } from "node:fs";
import { HOOK_SCRIPT } from "./hookScript";
import { ObsidianVaultGateway } from "./obsidian/vaultGateway";
import { RealGitBackend } from "./backends/git";
import { ZellijBackend, DEFAULT_TERMINAL_COMMAND, DEFAULT_ZELLIJ_BIN } from "./backends/zellij";
import { ClaudeBackend } from "./backends/claude";
import { Orchestrator } from "./core/orchestrator";
import { StatusIngest } from "./core/statusIngest";
import { registerTaskCodeBlock, ActionId } from "./obsidian/taskCodeBlock";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./obsidian/dashboardView";
import { DiffModal } from "./obsidian/diffPanel";
import type { TaskNote } from "./domain/types";

interface OawmSettings {
  terminalCommand: string;
  zellijPath: string;
}

const DEFAULT_SETTINGS: OawmSettings = {
  terminalCommand: DEFAULT_TERMINAL_COMMAND,
  zellijPath: DEFAULT_ZELLIJ_BIN,
};

export default class OawmPlugin extends Plugin {
  settings!: OawmSettings;
  private orchestrator!: Orchestrator;
  private vault!: ObsidianVaultGateway;
  private git!: RealGitBackend;
  private mux!: ZellijBackend;
  private statusDir!: string;
  private ingest!: StatusIngest;
  private sweepTimer?: number;
  private fsWatcher?: ReturnType<typeof fsWatch>;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new OawmSettingTab(this.app, this));

    const vaultRoot = (this.app.vault.adapter as any).getBasePath?.() ?? "";
    this.statusDir = join(vaultRoot, ".oawm", "status");
    // Write the hook helper next to the plugin on load so it is always present
    // and version-matched — no separate install step, self-heals a missing file.
    const hookHelperPath = join(vaultRoot, this.manifest.dir ?? "", "oawm-hook.mjs");
    try {
      writeFileSync(hookHelperPath, HOOK_SCRIPT);
    } catch (e) {
      new Notice(`OAWM: could not write hook helper (${String(e)})`);
    }

    this.vault = new ObsidianVaultGateway(this.app);
    this.git = new RealGitBackend();
    this.mux = new ZellijBackend(this.settings.terminalCommand, this.settings.zellijPath);
    const notifier = { notice: (m: string) => new Notice(`OAWM: ${m}`), confirm: async (m: string) => confirm(m) };
    const agent = new ClaudeBackend({ mux: this.mux, hookHelperPath, statusDir: this.statusDir });
    this.orchestrator = new Orchestrator({ vault: this.vault, git: this.git, mux: this.mux, agent, notifier, vaultRoot });

    this.ingest = new StatusIngest({ vault: this.vault, reconcile: (p) => this.orchestrator.reconcileTask(p) });

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
    this.addCommand({
      id: "reconcile-tasks",
      name: "Reconcile tasks (self-heal state)",
      callback: () => { void this.sweep().then(() => new Notice("OAWM: reconciled tasks")); },
    });

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
    this.startStatusWatcher(this.ingest);

    // Self-healing sweep every 15s, plus once on load (the plugin may have been
    // closed while agents were active or hooks fired).
    this.sweepTimer = window.setInterval(() => void this.sweep(), 15000);
    this.registerInterval(this.sweepTimer);
    void this.sweep();
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
      if (task.status !== "Running") continue;
      // Self-heal from the durable marker file (recovers a hook event whose
      // fsWatch notification was dropped or fired while the plugin was closed),
      // then reconcile liveness (dead session -> Failed).
      await this.selfHealFromMarker(task.id);
      void this.orchestrator.reconcileTask(task.path);
    }
  }

  private async selfHealFromMarker(taskId: string) {
    try {
      const raw = readFileSync(join(this.statusDir, `${taskId}.json`), "utf8");
      await this.ingest.ingest(taskId, raw);
    } catch { /* no marker for this task yet */ }
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

class OawmSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: OawmPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Terminal command")
      .setDesc(
        "Terminal emulator used to launch and attach to agent sessions. The session command is appended after this prefix. " +
        "Examples: \"gnome-terminal --\", \"konsole -e\", \"xterm -e\", \"alacritty -e\", \"kitty\", \"wezterm start --\". " +
        "Takes effect on the next plugin reload.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_TERMINAL_COMMAND)
          .setValue(this.plugin.settings.terminalCommand)
          .onChange(async (value) => {
            this.plugin.settings.terminalCommand = value.trim() || DEFAULT_TERMINAL_COMMAND;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName("Zellij path")
      .setDesc(
        "Path to the zellij binary. Use an absolute path (e.g. \"/opt/zellij\") if zellij is not on PATH " +
        "for non-interactive processes — a shell alias in ~/.bashrc is not visible here. " +
        "Takes effect on the next plugin reload.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_ZELLIJ_BIN)
          .setValue(this.plugin.settings.zellijPath)
          .onChange(async (value) => {
            this.plugin.settings.zellijPath = value.trim() || DEFAULT_ZELLIJ_BIN;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );
  }
}
