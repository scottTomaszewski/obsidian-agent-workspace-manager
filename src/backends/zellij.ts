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

/** Double-quote a string for embedding in a KDL layout file. */
function kdlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build a zellij KDL layout whose single pane runs the agent command. zellij's
 * CLI does not accept `zellij -s NAME -- command`; running a command in a fresh
 * session is done via a layout. The pane runs `bash -lc "<command>; exec bash"`
 * so the pane stays open after the agent exits.
 */
export function buildLayout(command: string): string {
  const inner = `${command}; exec bash`;
  return [
    "layout {",
    `    pane command="bash" {`,
    `        args "-lc" ${kdlString(inner)}`,
    "    }",
    "}",
    "",
  ].join("\n");
}

/**
 * Build the bash launcher script run inside the terminal window. It exports the
 * agent env and cd's to the worktree (reliable even when the emulator routes
 * through a server that ignores per-invocation cwd/env; the new session and its
 * panes inherit this cwd/env), starts a new zellij session with the layout, and
 * ALWAYS drops to an interactive shell afterward — so if zellij fails the window
 * stays open with the error visible instead of vanishing.
 */
export function buildLaunchScript(
  bin: string, session: string, cwd: string, env: Record<string, string>, layoutPath: string,
): string {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shquote(v)}`);
  return [
    "#!/usr/bin/env bash",
    `cd ${shquote(cwd)} || true`,
    ...exports,
    `${shquote(bin)} -s ${shquote(session)} -l ${shquote(layoutPath)}`,
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
    const dir = mkdtempSync(join(tmpdir(), "oawm-launch-"));
    const layoutPath = join(dir, "layout.kdl");
    writeFileSync(layoutPath, buildLayout(command));
    const scriptPath = join(dir, "launch.sh");
    writeFileSync(scriptPath, buildLaunchScript(this.bin, session, cwd, env, layoutPath), { mode: 0o700 });
    await this.terminal.open(["bash", scriptPath], { cwd, env });
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
