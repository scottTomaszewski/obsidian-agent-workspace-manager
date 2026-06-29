import type { PtyBackend, PtyHandle } from "../core/ports";

/** The slice of node-pty's IPty we use — kept minimal so tests can stub it. */
export interface RawPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; name: string; cols: number; rows: number },
) => RawPty;

/** Builds a spawn fn that loads node-pty from the plugin's own node_modules by
 *  absolute path (Obsidian's renderer require does not resolve plugin-relative),
 *  falling back to a bare require. Loaded lazily so a missing binary only fails
 *  at spawn time — TerminalView turns that into the in-pane install prompt. */
export function makeDefaultSpawn(pluginDir: string): PtySpawn {
  return (file, args, opts) => {
    const req = (window as unknown as { require: (id: string) => unknown }).require;
    const path = req("path") as { join: (...p: string[]) => string };
    let pty: { spawn: PtySpawn };
    try {
      pty = req(path.join(pluginDir, "node_modules", "node-pty")) as { spawn: PtySpawn };
    } catch {
      pty = req("node-pty") as { spawn: PtySpawn };
    }
    return pty.spawn(file, args, opts);
  };
}

export class NodePtyHost implements PtyBackend {
  constructor(private ptySpawn: PtySpawn) {}

  spawn(argv: string[], opts: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number }): PtyHandle {
    const raw = this.ptySpawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
      name: "xterm-color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    });
    return {
      onData: (cb) => raw.onData(cb),
      onExit: (cb) => raw.onExit((e) => cb(e.exitCode)),
      write: (d) => raw.write(d),
      resize: (c, r) => raw.resize(c, r),
      kill: () => raw.kill(),
    };
  }
}
