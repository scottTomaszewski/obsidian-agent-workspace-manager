import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { AgentBackend, LaunchArgs, MuxBackend } from "../core/ports";

/** Expand a leading `~` / `~/` to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Single-quote a string for safe embedding in a bash command. */
function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell command that launches the agent, seeding it with the task
 * goal when present. The prompt is passed via `"$(cat <file>)"` so arbitrary
 * goal text (quotes, newlines) survives the shell/KDL quoting layers intact.
 * Returns the command and the prompt file written (if any).
 */
export function buildAgentCommand(baseCommand: string, prompt: string): string {
  const cmd = baseCommand || "claude";
  if (!prompt.trim()) return cmd;
  const promptFile = join(mkdtempSync(join(tmpdir(), "oawm-prompt-")), "prompt.md");
  writeFileSync(promptFile, prompt);
  return `${cmd} "$(cat ${shquote(promptFile)})"`;
}

export function buildHookSettings(taskId: string, hookHelperPath: string, statusDir: string, hookCommandPrefix = "") {
  // The helper is invoked through `node`; a prefix (e.g. "devbox run --") lets
  // hosts that don't have node on PATH supply it via their env manager.
  const prefix = hookCommandPrefix.trim();
  const interpreter = prefix ? `${prefix} node` : "node";
  const cmd = (event: string) =>
    `${interpreter} ${JSON.stringify(hookHelperPath)} ${event} --task ${taskId} --status-dir ${JSON.stringify(statusDir)}`;
  return {
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: cmd("waiting") }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd("review") }] }],
    },
  };
}

export class ClaudeBackend implements AgentBackend {
  constructor(private deps: { mux: MuxBackend; hookHelperPath: string; statusDir: string; hookCommandPrefix?: string }) {}

  async launch(args: LaunchArgs): Promise<{ session: string }> {
    const session = `oawm-${args.task.id}`;
    // Clear any stale status marker from a previous run so the self-healing
    // re-scan can't resurrect old state (e.g. a leftover NeedsReview) for the
    // fresh session.
    rmSync(join(this.deps.statusDir, `${args.task.id}.json`), { force: true });
    const claudeDir = join(args.cwd, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settings = buildHookSettings(args.task.id, this.deps.hookHelperPath, this.deps.statusDir, this.deps.hookCommandPrefix);
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify(settings, null, 2));
    // The agent's extra env first, then CLAUDE_CONFIG_DIR from the dedicated
    // account field (when set) so it wins over any env entry of the same name.
    const env: Record<string, string> = { ...args.agent.env };
    if (args.agent.account.configDir) {
      env.CLAUDE_CONFIG_DIR = expandTilde(args.agent.account.configDir);
    }
    const command = buildAgentCommand(args.agent.command, args.prompt);
    await this.deps.mux.create(session, args.cwd, command, env);
    return { session };
  }
}
