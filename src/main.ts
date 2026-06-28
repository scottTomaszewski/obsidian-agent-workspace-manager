import { Plugin, TFile, Notice, WorkspaceLeaf, normalizePath, PluginSettingTab, Setting, App } from "obsidian";
import { join } from "node:path";
import { mkdirSync, watch as fsWatch, readFileSync, writeFileSync } from "node:fs";
import { HOOK_SCRIPT } from "./hookScript";
import { ObsidianVaultGateway } from "./obsidian/vaultGateway";
import { RealGitBackend } from "./backends/git";
import { ZellijBackend, DEFAULT_TERMINAL_COMMAND, DEFAULT_ZELLIJ_BIN } from "./backends/zellij";
import { SpawnTerminalLauncher } from "./backends/terminal";
import { EmbeddedTerminalLauncher } from "./obsidian/embeddedTerminal";
import { ClaudeBackend } from "./backends/claude";
import { Orchestrator } from "./core/orchestrator";
import { CompletionCoordinator } from "./core/completion";
import { CommitCoordinator } from "./core/commit";
import { StatusIngest } from "./core/statusIngest";
import { registerTaskCodeBlock, ActionId } from "./obsidian/taskCodeBlock";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./obsidian/dashboardView";
import { DiffView, DIFF_VIEW_TYPE, openDiffLeaf, DiffPrefsGateway, DiffTarget } from "./obsidian/diffView";
import { ChangesView, CHANGES_VIEW_TYPE } from "./obsidian/changesView";
import { TerminalView, TERMINAL_VIEW_TYPE } from "./obsidian/terminalView";
import { NodePtyHost } from "./backends/pty";
import { buildEditorCommand } from "./core/editorOpen";
import { resolveTaskWorktrees } from "./core/worktrees";
import type { TaskNote } from "./domain/types";

interface OawmSettings {
  terminalHost: "embedded" | "external";
  terminalCommand: string;
  zellijPath: string;
  diffTarget: DiffTarget;
  diffLayout: "unified" | "sideBySide";
  diffWrap: boolean;
  editorStrategy: "mux" | "external";
  editorCommand: string;
}

const DEFAULT_SETTINGS: OawmSettings = {
  terminalHost: "embedded",
  terminalCommand: DEFAULT_TERMINAL_COMMAND,
  zellijPath: DEFAULT_ZELLIJ_BIN,
  diffTarget: "popout",
  diffLayout: "sideBySide",
  diffWrap: false,
  editorStrategy: "mux",
  editorCommand: "nvim +{line} {file}",
};

export default class OawmPlugin extends Plugin {
  settings!: OawmSettings;
  private orchestrator!: Orchestrator;
  private completion!: CompletionCoordinator;
  private vault!: ObsidianVaultGateway;
  private git!: RealGitBackend;
  private mux!: ZellijBackend;
  private pty!: NodePtyHost;
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
    this.pty = new NodePtyHost();
    this.registerView(TERMINAL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TerminalView(leaf, this.pty));
    const launcher = this.settings.terminalHost === "embedded"
      ? new EmbeddedTerminalLauncher(this.app)
      : new SpawnTerminalLauncher(this.settings.terminalCommand || DEFAULT_TERMINAL_COMMAND);
    this.mux = new ZellijBackend(launcher, this.settings.zellijPath);
    const notifier = { notice: (m: string) => new Notice(`OAWM: ${m}`), confirm: async (m: string) => confirm(m) };
    const agent = new ClaudeBackend({ mux: this.mux, hookHelperPath, statusDir: this.statusDir });
    this.completion = new CompletionCoordinator({ vault: this.vault, git: this.git, mux: this.mux, notifier });
    const commit = new CommitCoordinator({ vault: this.vault, git: this.git, notifier });
    this.orchestrator = new Orchestrator({ vault: this.vault, git: this.git, mux: this.mux, agent, notifier, vaultRoot, completion: this.completion });

    this.ingest = new StatusIngest({ vault: this.vault, reconcile: (p) => this.orchestrator.reconcileTask(p) });

    // Action bar
    registerTaskCodeBlock(this, {
      getTaskByPath: (p) => this.vault.getTask(p),
      onAction: (action, task) => this.handleAction(action, task),
    });

    // Dashboard view
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
      new DashboardView(leaf, this.vault, (path) => this.openTask(path), (path) => this.activateChanges(path)));
    const diffPrefs: DiffPrefsGateway = {
      get: () => ({ layout: this.settings.diffLayout, wrap: this.settings.diffWrap }),
      set: async (p) => {
        this.settings.diffLayout = p.layout;
        this.settings.diffWrap = p.wrap;
        await this.saveData(this.settings);
      },
    };
    this.registerView(DIFF_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DiffView(leaf, diffPrefs));
    this.registerView(CHANGES_VIEW_TYPE, (leaf: WorkspaceLeaf) =>
      new ChangesView(leaf, {
        vault: this.vault, git: this.git, completion: this.completion, commit,
        openDiff: (title, diff) => openDiffLeaf(this.app, this.settings.diffTarget, { title, diff }),
        openEditor: (task, repo, path) => this.openEditor(task, repo, path),
        openExternal: (url) => { const { shell } = require("electron"); shell.openExternal(url); },
      }));
    this.addRibbonIcon("bot", "Agent Workspace", () => this.activateDashboard());
    this.addCommand({ id: "open-dashboard", name: "Open Agent Workspace", callback: () => this.activateDashboard() });
    this.addCommand({ id: "open-changes", name: "Open Task Changes panel", callback: () => this.activateChanges(null) });
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
      case "restart": await this.vault.patchTask(task.path, { agentState: "", status: "Running" }); break;
      case "openTerminal": if (task.session) await this.mux.focus(task.session); return;
      case "viewDiff": await this.activateChanges(task.path); return;
      case "merge": await this.completion.merge(task, { push: false }); break;
      case "mergePush": await this.completion.merge(task, { push: true }); break;
      case "push": await this.completion.pushBranch(task); break;
      case "openPr": {
        const { url } = await this.completion.openPr(task);
        if (url) { const { shell } = require("electron"); shell.openExternal(url); }
        break;
      }
    }
    await this.orchestrator.reconcileTask(task.path);
  }

  private async activateChanges(taskPath: string | null) {
    const existing = this.app.workspace.getLeavesOfType(CHANGES_VIEW_TYPE);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) { new Notice("OAWM: could not open changes panel"); return; }
    await leaf.setViewState({ type: CHANGES_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof ChangesView) await view.showTask(taskPath);
  }

  private async openEditor(task: TaskNote, repo: string, path: string) {
    const ws = await this.vault.getWorkspace(task.workspace);
    if (!ws) return;
    const wt = resolveTaskWorktrees(task, ws).find((w) => w.repo === repo);
    if (!wt) return;
    if (!this.settings.editorCommand.trim()) { new Notice("OAWM: set an editor command in settings"); return; }
    const command = buildEditorCommand(this.settings.editorCommand, { file: join(wt.path, path) });
    if (this.settings.editorStrategy === "mux") {
      if (!task.session) { new Notice("OAWM: no terminal session for this task"); return; }
      await this.mux.openPane(task.session, wt.path, command);
    } else {
      const { spawn } = require("node:child_process");
      spawn("bash", ["-lc", command], { cwd: wt.path, detached: true, stdio: "ignore" }).unref();
    }
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
      .setName("Terminal host")
      .setDesc("Where agent terminals open. \"Embedded\" runs them inside Obsidian; \"External window\" spawns a terminal emulator. Takes effect on the next plugin reload.")
      .addDropdown((d) =>
        d.addOption("embedded", "Embedded").addOption("external", "External window")
          .setValue(this.plugin.settings.terminalHost)
          .onChange(async (v) => { this.plugin.settings.terminalHost = v as "embedded" | "external"; await this.plugin.saveData(this.plugin.settings); }));

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

    new Setting(containerEl)
      .setName("Diff window")
      .setDesc("Where file diffs open. \"Popout\" opens a separate window so you can read a diff while referencing code in the main window; \"Split\" opens in the main editor area; \"New tab\" opens a tab alongside your notes.")
      .addDropdown((d) =>
        d.addOption("popout", "Popout window").addOption("split", "Main split").addOption("tab", "New tab")
          .setValue(this.plugin.settings.diffTarget)
          .onChange(async (v) => { this.plugin.settings.diffTarget = v as DiffTarget; await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Editor open strategy")
      .setDesc("How the ✎ affordance opens a file. \"Terminal pane\" opens it in a new pane in the task's zellij session (works over SSH); \"External\" spawns a GUI editor command.")
      .addDropdown((d) =>
        d.addOption("mux", "Terminal pane (zellij)").addOption("external", "External command")
          .setValue(this.plugin.settings.editorStrategy)
          .onChange(async (v) => { this.plugin.settings.editorStrategy = v as "mux" | "external"; await this.plugin.saveData(this.plugin.settings); }));

    new Setting(containerEl)
      .setName("Editor command")
      .setDesc("Command template with {file} and {line} placeholders. Examples: \"nvim +{line} {file}\", \"glow {file}\", \"code -g {file}:{line}\".")
      .addText((t) =>
        t.setPlaceholder("nvim +{line} {file}").setValue(this.plugin.settings.editorCommand)
          .onChange(async (v) => { this.plugin.settings.editorCommand = v; await this.plugin.saveData(this.plugin.settings); }));
  }
}
