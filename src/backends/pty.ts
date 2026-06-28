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

/** Loads node-pty lazily so a missing/incompatible native binary only fails at spawn time. */
function defaultSpawn(file: string, args: string[], opts: Parameters<PtySpawn>[2]): RawPty {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require("@homebridge/node-pty-prebuilt-multiarch");
  return pty.spawn(file, args, opts);
}

export class NodePtyHost implements PtyBackend {
  constructor(private ptySpawn: PtySpawn = defaultSpawn) {}

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
