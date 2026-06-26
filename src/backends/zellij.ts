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

export const zellijArgs = {
  // Build the zellij argv that runs the agent inside a fresh session. cwd and
  // env are baked into the bash script rather than passed via the process
  // environment, because terminal emulators (e.g. gnome-terminal) route through
  // a pre-existing server that does not inherit per-invocation cwd/env. The
  // trailing `exec bash` keeps the pane open after the agent exits so the user
  // can inspect it.
  create(session: string, cwd: string, command: string, env: Record<string, string>): string[] {
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shquote(v)};`)
      .join(" ");
    const script = `cd ${shquote(cwd)}; ${exports} ${command}; exec bash`;
    return ["-s", session, "--", "bash", "-lc", script];
  },
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
    await this.terminal.open([this.bin, ...zellijArgs.create(session, cwd, command, env)], { cwd, env });
  }

  async kill(session: string): Promise<void> {
    await run(this.bin, zellijArgs.kill(session));
  }

  async focus(session: string): Promise<void> {
    await this.terminal.open([this.bin, ...zellijArgs.attach(session)]);
  }

  async isAlive(session: string): Promise<boolean> {
    const res = await run(this.bin, zellijArgs.list());
    return parseAliveSessions(res.stdout).includes(session);
  }
}
