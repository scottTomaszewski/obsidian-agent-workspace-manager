import { Plugin, TFile, Notice, WorkspaceLeaf, normalizePath, PluginSettingTab, Setting, App, requestUrl } from "obsidian";
import { join } from "node:path";
import { mkdirSync, watch as fsWatch, readFileSync, writeFileSync, existsSync, rmSync, chmodSync, readdirSync } from "node:fs";
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
import { NodePtyHost, makeDefaultSpawn } from "./backends/pty";
import { NodePtyProvisioner } from "./backends/ptyBinary";
import { run } from "./backends/exec";
import { buildEditorCommand } from "./core/editorOpen";
import { VERSION } from "./version";
import { createHash } from "node:crypto";
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
  hookCommandPrefix: string;
  pinnedBaseRefs: Record<string, string>;
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
  hookCommandPrefix: "",
  pinnedBaseRefs: {},
};

export default class OawmPlugin extends Plugin {
  settings!: OawmSettings;
  private orchestrator!: Orchestrator;
  private completion!: CompletionCoordinator;
  private vault!: ObsidianVaultGateway;
  private git!: RealGitBackend;
  private mux!: ZellijBackend;
  private pty!: NodePtyHost;
  provisioner!: NodePtyProvisioner;
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
    const pluginDir = join(vaultRoot, this.manifest.dir ?? "");
    this.provisioner = new NodePtyProvisioner({
      pluginDir,
      repo: "scottTomaszewski/obsidian-agent-workspace-manager",
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      patchText: "", // win32 ConPTY patch deferred — see FOLLOWUPS
      join: (...parts: string[]) => join(...parts),
      fetch: async (url: string) => {
        const resp = await requestUrl({ url });
        return { json: () => resp.json, bytes: () => new Uint8Array(resp.arrayBuffer) };
      },
      fs: {
        exists: (p) => existsSync(p),
        mkdir: (p) => mkdirSync(p, { recursive: true }),
        writeFile: (p, data) => writeFileSync(p, data as NodeJS.ArrayBufferView | string),
        rm: (p) => rmSync(p, { recursive: true, force: true }),
        chmod: (p, mode) => chmodSync(p, mode),
        listing: (dir, platform, arch) => {
          const prebuildDir = join(dir, "prebuilds", `${platform}-${arch}`);
          const buildRelease = join(dir, "build", "Release");
          const hasNode = (d: string) => { try { return readdirSync(d).some((f) => f.endsWith(".node")); } catch { return false; } };
          return {
            hasEntryJs: existsSync(join(dir, "lib", "index.js")),
            hasPrebuild: hasNode(prebuildDir) || hasNode(buildRelease),
            hasSpawnHelper: existsSync(join(prebuildDir, "spawn-helper")),
            hasWinPatch: existsSync(join(dir, "lib", "windowsConoutConnection.js")),
          };
        },
      },
      extract: async (zipPath, destDir) => {
        if (process.platform === "win32") {
          const r = await run("powershell", ["-NoProfile", "-Command",
            `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]);
          if (r.code !== 0) throw new Error(`Extraction failed (code ${r.code})${r.stderr ? `: ${r.stderr}` : ""}`);
        } else {
          const r = await run("unzip", ["-o", zipPath, "-d", destDir]);
          if (r.code !== 0) throw new Error(`Extraction failed (code ${r.code})${r.stderr ? `: ${r.stderr}` : ""}`);
        }
      },
      sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    });
    this.pty = new NodePtyHost(makeDefaultSpawn(pluginDir));
    this.registerView(TERMINAL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TerminalView(leaf, this.pty, this.provisioner));
    const launcher = this.settings.terminalHost === "embedded"
      ? new EmbeddedTerminalLauncher(this.app)
      : new SpawnTerminalLauncher(this.settings.terminalCommand || DEFAULT_TERMINAL_COMMAND);
    this.mux = new ZellijBackend(launcher, this.settings.zellijPath);
    const notifier = { notice: (m: string) => new Notice(`OAWM: ${m}`), confirm: async (m: string) => confirm(m) };
    const agent = new ClaudeBackend({ mux: this.mux, hookHelperPath, statusDir: this.statusDir, hookCommandPrefix: this.settings.hookCommandPrefix });
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
        pinnedBaseRefs: () => this.settings.pinnedBaseRefs,
        setBaseRef: async (repoPath, ref) => {
          if (ref) this.settings.pinnedBaseRefs[repoPath] = ref;
          else delete this.settings.pinnedBaseRefs[repoPath];
          await this.saveData(this.settings);
        },
        openDiff: (title, diff) => openDiffLeaf(this.app, this.settings.diffTarget, { title, diff }),
        openEditor: (dir, path, session) => this.openEditor(dir, path, session),
        openExternal: (url) => { const { shell } = require("electron"); shell.openExternal(url); },
        notify: (msg) => new Notice(msg),
      }));
    this.addRibbonIcon("bot", "Agent Workspace", () => this.activateDashboard());
    this.addCommand({ id: "open-dashboard", name: "Open Agent Workspace", callback: () => this.activateDashboard() });
    this.addCommand({ id: "open-changes", name: "Open Workspace Changes panel", callback: () => this.activateChanges(null) });
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

  private async openEditor(dir: string, path: string, session: string | null) {
    if (!this.settings.editorCommand.trim()) { new Notice("OAWM: set an editor command in settings"); return; }
    const command = buildEditorCommand(this.settings.editorCommand, { file: join(dir, path) });
    if (this.settings.editorStrategy === "mux") {
      if (!session) { new Notice("OAWM: no terminal session for this checkout"); return; }
      await this.mux.openPane(session, dir, command);
    } else {
      const { spawn } = require("node:child_process");
      spawn("bash", ["-lc", command], { cwd: dir, detached: true, stdio: "ignore" }).unref();
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
    const s = this.plugin.settings;
    const save = () => this.plugin.saveData(s);

    // --- Agent terminal ---
    new Setting(containerEl).setName("Agent terminal").setHeading();

    new Setting(containerEl)
      .setName("Terminal host")
      .setDesc("Where agent terminals open. \"Embedded\" runs them inside Obsidian; \"External window\" spawns a terminal emulator. Takes effect on the next plugin reload.")
      .addDropdown((d) =>
        d.addOption("embedded", "Embedded").addOption("external", "External window")
          .setValue(s.terminalHost)
          .onChange(async (v) => { s.terminalHost = v as "embedded" | "external"; await save(); this.display(); }));

    if (s.terminalHost === "external") {
      new Setting(containerEl)
        .setName("Terminal command")
        .setDesc("Terminal emulator used to launch and attach to agent sessions. The session command is appended after this prefix. Examples: \"gnome-terminal --\", \"konsole -e\", \"xterm -e\", \"alacritty -e\", \"kitty\", \"wezterm start --\". Takes effect on the next plugin reload.")
        .addText((t) =>
          t.setPlaceholder(DEFAULT_TERMINAL_COMMAND).setValue(s.terminalCommand)
            .onChange(async (v) => { s.terminalCommand = v.trim() || DEFAULT_TERMINAL_COMMAND; await save(); }));
    }

    new Setting(containerEl)
      .setName("Terminal support (native component)")
      .setDesc("Downloads node-pty for the embedded terminal from this plugin's GitHub release, verified by checksum. Required only for the embedded host.")
      .addButton((b) =>
        b.setButtonText("Download / re-download").onClick(async () => {
          b.setDisabled(true);
          const r = await this.plugin.provisioner.install((m) => b.setButtonText(m));
          new Notice(r.ok ? "OAWM: terminal support installed." : `OAWM: ${r.message}`);
          b.setDisabled(false);
          b.setButtonText("Download / re-download");
        }))
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove downloaded binary").onClick(async () => {
          await this.plugin.provisioner.remove();
          new Notice("OAWM: terminal support removed.");
        }));

    new Setting(containerEl)
      .setName("Multiplexer path")
      .setDesc("Path to the zellij binary. Use an absolute path (e.g. \"/opt/zellij\") if zellij is not on PATH for non-interactive processes — a shell alias in ~/.bashrc is not visible here. Takes effect on the next plugin reload.")
      .addText((t) =>
        t.setPlaceholder(DEFAULT_ZELLIJ_BIN).setValue(s.zellijPath)
          .onChange(async (v) => { s.zellijPath = v.trim() || DEFAULT_ZELLIJ_BIN; await save(); }));

    new Setting(containerEl)
      .setName("Hook command prefix")
      .setDesc("Prepended before \"node\" when Claude Code invokes the status hook (e.g. \"devbox run --\" so the hook finds node on a host where node isn't on PATH). Leave blank to call node directly. Takes effect on the next launch.")
      .addText((t) =>
        t.setPlaceholder("devbox run --").setValue(s.hookCommandPrefix)
          .onChange(async (v) => { s.hookCommandPrefix = v.trim(); await save(); }));

    // --- Editor ---
    new Setting(containerEl).setName("Editor").setHeading();

    new Setting(containerEl)
      .setName("Open strategy")
      .setDesc("How the ✎ affordance opens a file. \"Terminal pane\" opens it in a new pane in the task's zellij session (works over SSH); \"External command\" spawns a GUI editor command.")
      .addDropdown((d) =>
        d.addOption("mux", "Terminal pane (zellij)").addOption("external", "External command")
          .setValue(s.editorStrategy)
          .onChange(async (v) => { s.editorStrategy = v as "mux" | "external"; await save(); this.display(); }));

    if (s.editorStrategy === "external") {
      new Setting(containerEl)
        .setName("Editor command")
        .setDesc("Command template with {file} and {line} placeholders. Examples: \"nvim +{line} {file}\", \"glow {file}\", \"code -g {file}:{line}\".")
        .addText((t) =>
          t.setPlaceholder("nvim +{line} {file}").setValue(s.editorCommand)
            .onChange(async (v) => { s.editorCommand = v; await save(); }));
    }

    // --- Diff ---
    new Setting(containerEl).setName("Diff").setHeading();

    new Setting(containerEl)
      .setName("Diff window")
      .setDesc("Where file diffs open. \"Popout\" opens a separate window so you can read a diff while referencing code in the main window; \"Split\" opens in the main editor area; \"New tab\" opens a tab alongside your notes.")
      .addDropdown((d) =>
        d.addOption("popout", "Popout window").addOption("split", "Main split").addOption("tab", "New tab")
          .setValue(s.diffTarget)
          .onChange(async (v) => { s.diffTarget = v as DiffTarget; await save(); }));
  }
}
