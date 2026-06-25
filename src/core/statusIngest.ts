import type { AgentState, TaskNote } from "../domain/types";
import type { VaultGateway } from "./ports";

export function parseMarker(raw: string): { state: AgentState } | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  const event = (data as { event?: string })?.event;
  if (event === "waiting") return { state: "Waiting" };
  if (event === "review") return { state: "NeedsReview" };
  return null;
}

export class StatusIngest {
  constructor(private deps: { vault: VaultGateway; reconcile: (path: string) => Promise<void> }) {}

  async ingest(taskId: string, raw: string): Promise<void> {
    const parsed = parseMarker(raw);
    if (!parsed) return;
    const tasks = await this.deps.vault.listTasks();
    const match = tasks.find((t: TaskNote) => t.id === taskId);
    if (!match) return;
    await this.deps.vault.patchTask(match.path, { agentState: parsed.state });
    await this.deps.reconcile(match.path);
  }
}
