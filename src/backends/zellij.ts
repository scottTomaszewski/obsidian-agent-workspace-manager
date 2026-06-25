import type { MuxBackend } from "../core/ports";
import { run } from "./exec";

export const zellijArgs = {
  create(session: string, _cwd: string, command: string): string[] {
    // Launch a detached session that runs `command`, then drops to a shell.
    return ["-s", session, "--", "bash", "-lc", `${command}; exec bash`];
  },
  kill(session: string): string[] { return ["kill-session", session]; },
  list(): string[] { return ["list-sessions", "--no-formatting"]; },
};

export class ZellijBackend implements MuxBackend {
  async create(session: string, cwd: string, command: string, env: Record<string, string>): Promise<void> {
    const res = await run("zellij", zellijArgs.create(session, cwd, command), {
      cwd, env: { ...process.env, ...env },
    });
    if (res.code !== 0) throw new Error(`zellij create failed: ${res.stderr}`);
  }
  async kill(session: string): Promise<void> {
    await run("zellij", zellijArgs.kill(session));
  }
  async focus(session: string): Promise<void> {
    // Best-effort: attach in a new terminal is environment-specific; POC focuses by
    // surfacing the session name. Attaching is documented in the manual checklist.
    await run("zellij", ["attach", session]);
  }
  async isAlive(session: string): Promise<boolean> {
    const res = await run("zellij", zellijArgs.list());
    return res.stdout.split("\n").some((line) => line.trim().startsWith(session));
  }
}
