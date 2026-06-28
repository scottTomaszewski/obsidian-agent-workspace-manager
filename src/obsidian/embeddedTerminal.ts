import type { App } from "obsidian";
import type { TerminalLauncher } from "../backends/terminal";
import { TERMINAL_VIEW_TYPE, TerminalView } from "./terminalView";

/**
 * TerminalLauncher that runs the command inside an in-Obsidian TerminalView leaf
 * (one leaf per session `key`) instead of an external OS terminal window. Reveals
 * an existing leaf for the same key rather than opening a duplicate.
 */
export class EmbeddedTerminalLauncher implements TerminalLauncher {
  constructor(private app: App) {}

  async open(
    inner: string[],
    opts: { cwd?: string; env?: Record<string, string>; key?: string; title?: string } = {},
  ): Promise<void> {
    const key = opts.key ?? inner.join(" ");
    const existing = this.app.workspace
      .getLeavesOfType(TERMINAL_VIEW_TYPE)
      .find((l) => (l.view as TerminalView).key === key);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    await (leaf.view as TerminalView).start({
      key,
      argv: inner,
      cwd: opts.cwd,
      env: opts.env,
      title: opts.title ?? key,
    });
  }
}
