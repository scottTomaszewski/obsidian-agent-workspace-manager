import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackend, LaunchArgs, MuxBackend } from "../core/ports";

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
    const env = { CLAUDE_CONFIG_DIR: args.agent.account.configDir };
    await this.deps.mux.create(session, args.cwd, "claude", env);
    return { session };
  }
}
