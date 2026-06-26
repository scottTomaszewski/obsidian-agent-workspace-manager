import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentBackend, LaunchArgs, MuxBackend } from "../core/ports";

/** Expand a leading `~` / `~/` to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function buildHookSettings(taskId: string, hookHelperPath: string, statusDir: string) {
  const cmd = (event: string) =>
    `node ${JSON.stringify(hookHelperPath)} ${event} --task ${taskId} --status-dir ${JSON.stringify(statusDir)}`;
  return {
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: cmd("waiting") }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd("review") }] }],
    },
  };
}

export class ClaudeBackend implements AgentBackend {
  constructor(private deps: { mux: MuxBackend; hookHelperPath: string; statusDir: string }) {}

  async launch(args: LaunchArgs): Promise<{ session: string }> {
    const session = `oawm-${args.task.id}`;
    const claudeDir = join(args.cwd, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settings = buildHookSettings(args.task.id, this.deps.hookHelperPath, this.deps.statusDir);
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify(settings, null, 2));
    // The agent's extra env first, then CLAUDE_CONFIG_DIR from the dedicated
    // account field (when set) so it wins over any env entry of the same name.
    const env: Record<string, string> = { ...args.agent.env };
    if (args.agent.account.configDir) {
      env.CLAUDE_CONFIG_DIR = expandTilde(args.agent.account.configDir);
    }
    const command = args.agent.command || "claude";
    await this.deps.mux.create(session, args.cwd, command, env);
    return { session };
  }
}
