import { spawn } from "node:child_process";

/**
 * Build the argv to spawn, by splitting a terminal-command template into its
 * prefix tokens and appending the inner command.
 *
 * Most emulators follow `<term> <flag> <cmd> <args...>`, so a whitespace-split
 * prefix works: "gnome-terminal --" + ["zellij","attach","s"]
 *   → ["gnome-terminal","--","zellij","attach","s"]
 * "konsole -e" + [...] → ["konsole","-e", ...]; "kitty" + [...] → ["kitty", ...].
 */
export function buildTerminalArgv(terminalCommand: string, inner: string[]): string[] {
  const prefix = terminalCommand.trim().split(/\s+/).filter((t) => t.length > 0);
  return [...prefix, ...inner];
}

export interface TerminalLauncher {
  open(
    inner: string[],
    opts?: { cwd?: string; env?: Record<string, string>; key?: string; title?: string },
  ): Promise<void>;
}

/**
 * Launches a terminal-emulator window running `inner`, detached so it outlives
 * this process. Resolves once the emulator has spawned (not when it closes);
 * rejects if the emulator binary cannot be spawned (e.g. not installed).
 */
export class SpawnTerminalLauncher implements TerminalLauncher {
  constructor(private terminalCommand: string) {}

  open(inner: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
    const argv = buildTerminalArgv(this.terminalCommand, inner);
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}
