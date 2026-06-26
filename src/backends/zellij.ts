import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuxBackend } from "../core/ports";
import { run } from "./exec";
import { SpawnTerminalLauncher, type TerminalLauncher } from "./terminal";

export const DEFAULT_TERMINAL_COMMAND = "gnome-terminal --";
export const DEFAULT_ZELLIJ_BIN = "zellij";

/**
 * Parse the output of `zellij list-sessions --no-formatting` and return the
 * names of sessions that are NOT exited.
 * Each non-empty line's first whitespace-separated token is the session name;
 * lines containing "EXITED" (case-insensitive) are excluded.
 */
export function parseAliveSessions(listOutput: string): string[] {
  return listOutput
    .split("\n")
    .filter((line) => line.trim().length > 0 && !/EXITED/i.test(line))
    .map((line) => line.trim().split(/\s+/)[0]);
}

/** Single-quote a string for safe embedding in a bash script. */
function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the bash launcher script run inside the terminal window. It exports the
 * agent env and cd's to the worktree (reliable even when the emulator routes
 * through a server that ignores per-invocation cwd/env), runs the agent inside a
 * fresh zellij session, and ALWAYS drops to an interactive shell afterward — so
 * if zellij or the agent fails, the window stays open with the error visible
 * instead of vanishing.
 */
export function buildLaunchScript(
  bin: string, session: string, cwd: string, command: string, env: Record<string, string>,
): string {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shquote(v)}`);
  const paneCommand = shquote(`${command}; exec bash`);
  return [
    "#!/usr/bin/env bash",
    `cd ${shquote(cwd)} || true`,
    ...exports,
    `${shquote(bin)} -s ${shquote(session)} -- bash -lc ${paneCommand}`,
    "ec=$?",
    "echo",
    `echo "[oawm] zellij session ended (exit $ec). Window kept open so any error above is readable; press Ctrl-D to close."`,
    "exec bash",
  ].join("\n");
}

export const zellijArgs = {
  attach(session: string): string[] { return ["attach", session]; },
  kill(session: string): string[] { return ["kill-session", session]; },
  list(): string[] { return ["list-sessions", "--no-formatting"]; },
};

export class ZellijBackend implements MuxBackend {
  private terminal: TerminalLauncher;
  private bin: string;

  constructor(terminalCommand: string = DEFAULT_TERMINAL_COMMAND, zellijBin: string = DEFAULT_ZELLIJ_BIN) {
    this.terminal = new SpawnTerminalLauncher(terminalCommand || DEFAULT_TERMINAL_COMMAND);
    // The terminal emulator and Electron exec the binary by PATH lookup, where a
    // shell alias (e.g. for /opt/zellij) is not visible — so allow an explicit path.
    this.bin = zellijBin || DEFAULT_ZELLIJ_BIN;
  }

  // Launching and attaching need a real terminal, so they open an emulator
  // window. Killing and listing are headless CLI calls that need no TTY.
  async create(session: string, cwd: string, command: string, env: Record<string, string>): Promise<void> {
    const script = buildLaunchScript(this.bin, session, cwd, command, env);
    const file = join(mkdtempSync(join(tmpdir(), "oawm-launch-")), "launch.sh");
    writeFileSync(file, script, { mode: 0o700 });
    await this.terminal.open(["bash", file], { cwd, env });
  }

  async kill(session: string): Promise<void> {
    await run(this.bin, zellijArgs.kill(session));
  }

  async focus(session: string): Promise<void> {
    // Keep the window open if the attach fails (e.g. the session is gone).
    const script = `${shquote(this.bin)} attach ${shquote(session)}; echo; echo "[oawm] detached (exit $?). Ctrl-D to close."; exec bash`;
    await this.terminal.open(["bash", "-lc", script]);
  }

  async isAlive(session: string): Promise<boolean> {
    const res = await run(this.bin, zellijArgs.list());
    return parseAliveSessions(res.stdout).includes(session);
  }
}
