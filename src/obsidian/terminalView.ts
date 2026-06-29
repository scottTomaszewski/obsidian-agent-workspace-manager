import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { PtyBackend, PtyHandle, PtyProvisioner } from "../core/ports";

export const TERMINAL_VIEW_TYPE = "oawm-terminal";

export interface TerminalViewState {
  key: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  title: string;
}

export class TerminalView extends ItemView {
  private term?: Terminal;
  private fit?: FitAddon;
  private pty?: PtyHandle;
  private state?: TerminalViewState;

  constructor(leaf: WorkspaceLeaf, private ptyBackend: PtyBackend, private provisioner: PtyProvisioner) { super(leaf); }

  getViewType() { return TERMINAL_VIEW_TYPE; }
  getDisplayText() { return this.state ? `Terminal: ${this.state.title}` : "OAWM Terminal"; }
  getIcon() { return "terminal"; }

  /** The session key this leaf is bound to; used to reveal an existing leaf. */
  get key(): string | undefined { return this.state?.key; }

  async start(state: TerminalViewState) {
    this.state = state;
    const { state: s } = await this.provisioner.status();
    if (s === "ready") this.render();
    else this.renderInstallPrompt();
  }

  private render() {
    this.pty?.kill();
    this.term?.dispose();
    this.pty = undefined;
    this.term = undefined;
    this.fit = undefined;
    if (!this.state) return;
    const el = this.contentEl;
    el.empty();
    el.addClass("oawm-terminal");

    const term = new Terminal({ convertEol: true, fontFamily: "monospace", fontSize: 13, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    this.term = term;
    this.fit = fit;

    const { argv, cwd, env } = this.state;
    let pty: PtyHandle;
    try {
      pty = this.ptyBackend.spawn(argv, { cwd, env, cols: term.cols, rows: term.rows });
    } catch (e) {
      this.renderInstallPrompt(`Could not start the terminal: ${String(e)}`);
      return;
    }
    this.pty = pty;

    pty.onData((d) => term.write(d));
    term.onData((d) => pty.write(d));
    pty.onExit((code) => {
      term.write(`\r\n[oawm] session ended (exit ${code}). This pane is kept open so any error above is readable.\r\n`);
    });
    this.registerDomEvent(window, "resize", () => this.onResize());
  }

  private renderInstallPrompt(message?: string) {
    this.pty?.kill();
    this.term?.dispose();
    this.pty = undefined; this.term = undefined; this.fit = undefined;
    const el = this.contentEl;
    el.empty();
    el.addClass("oawm-terminal-setup");
    el.createEl("p", { text: "The in-app terminal needs a one-time native component (node-pty)." });
    if (message) el.createEl("p", { text: message, cls: "oawm-terminal-setup-msg" });
    const btn = el.createEl("button", { text: "Download terminal support" });
    const source = el.createEl("p", { cls: "oawm-terminal-setup-src" });
    source.setText("Downloaded from this plugin's GitHub release and verified by checksum.");
    const hint = el.createEl("p", { cls: "oawm-terminal-setup-hint" });
    hint.setText("Or switch Terminal host to \"External window\" in settings.");

    btn.onclick = async () => {
      btn.disabled = true;
      const onProgress = (m: string) => btn.setText(m);
      const r = await this.provisioner.install(onProgress);
      if (r.ok) {
        new Notice("OAWM: terminal support installed.");
        this.render();
      } else {
        btn.disabled = false;
        btn.setText("Retry download");
        this.renderInstallPrompt(r.message);
        new Notice(`OAWM: terminal support failed: ${r.message}`);
      }
    };
  }

  onResize() {
    if (this.fit && this.term && this.pty) {
      this.fit.fit();
      this.pty.resize(this.term.cols, this.term.rows);
    }
  }

  async onClose() {
    // The detached zellij session survives; we only drop this viewport.
    this.pty?.kill();
    this.term?.dispose();
  }
}
