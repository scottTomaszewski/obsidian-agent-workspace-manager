import { ItemView, WorkspaceLeaf } from "obsidian";
import type { TaskNote } from "../domain/types";
import type { VaultGateway, GitBackend } from "../core/ports";
import type { CompletionCoordinator } from "../core/completion";
import type { CommitCoordinator } from "../core/commit";
import { groupByRepo, stampRepo, commitEnabled, type FileChange } from "../core/changes";
import { resolveTaskWorktrees } from "../core/worktrees";
import { groupByState } from "./dashboardView";

export const CHANGES_VIEW_TYPE = "oawm-changes";

export interface ChangesViewDeps {
  vault: VaultGateway;
  git: GitBackend;
  completion: CompletionCoordinator;
  commit: CommitCoordinator;
  openDiff: (title: string, diff: string) => Promise<void>;
  openEditor: (task: TaskNote, repo: string, path: string) => Promise<void>;
  openExternal: (url: string) => void;
}

export class ChangesView extends ItemView {
  private activeTaskPath: string | null = null;
  private tab: "local" | "unmerged" = "local";
  private checked = new Set<string>();   // "repo\0path"
  private message = "";

  constructor(leaf: WorkspaceLeaf, private deps: ChangesViewDeps) { super(leaf); }
  getViewType() { return CHANGES_VIEW_TYPE; }
  getDisplayText() { return "Task Changes"; }
  getIcon() { return "git-pull-request"; }

  async onOpen() { await this.render(); }

  async showTask(path: string | null) {
    this.activeTaskPath = path;
    this.checked.clear();
    this.message = "";
    this.tab = "local";
    await this.render();
  }

  private key(repo: string, path: string) { return `${repo}\0${path}`; }

  private async render() {
    const root = this.contentEl;
    root.empty();
    if (!this.activeTaskPath) { await this.renderOverview(root); return; }
    const task = await this.deps.vault.getTask(this.activeTaskPath);
    if (!task) { await this.renderOverview(root); return; }
    await this.renderTask(root, task);
  }

  private async renderOverview(root: HTMLElement) {
    root.createEl("h4", { text: "Workspace Changes" });
    const tasks = (await this.deps.vault.listTasks()).filter((t) => t.branch && t.worktree);
    const groups = groupByState(tasks);
    for (const state of Object.keys(groups) as (keyof typeof groups)[]) {
      const list = groups[state];
      if (list.length === 0) continue;
      root.createEl("div", { cls: "oawm-changes-state", text: state });
      for (const t of list) {
        const row = root.createDiv({ cls: "oawm-changes-overrow" });
        const link = row.createEl("a", { text: `${t.id} — ${t.title}`, href: "#" });
        link.onclick = (e) => { e.preventDefault(); void this.showTask(t.path); };
        const counts = await this.countsFor(t);
        row.createSpan({ cls: "oawm-changes-count", text: ` ● ${counts.local} local  ↑ ${counts.unmerged} unmerged` });
      }
    }
    if (tasks.length === 0) root.createEl("em", { text: "No active tasks with worktrees." });
  }

  private async countsFor(task: TaskNote): Promise<{ local: number; unmerged: number }> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) return { local: 0, unmerged: 0 };
    let local = 0, unmerged = 0;
    for (const wt of resolveTaskWorktrees(task, ws)) {
      try { const c = await this.deps.git.unmergedCounts(wt.path, ws.baseBranch); local += c.local; unmerged += c.unmerged; } catch { /* worktree may not exist */ }
    }
    return { local, unmerged };
  }

  private async collect(task: TaskNote, scope: "local" | "unmerged"): Promise<FileChange[]> {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) return [];
    const all: FileChange[] = [];
    for (const wt of resolveTaskWorktrees(task, ws)) {
      try {
        const files = scope === "local"
          ? await this.deps.git.status(wt.path)
          : await this.deps.git.branchDiffFiles(wt.path, ws.baseBranch);
        all.push(...stampRepo(files, wt.repo));
      } catch { /* worktree may not exist yet */ }
    }
    return all;
  }

  private async renderTask(root: HTMLElement, task: TaskNote) {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    const base = ws?.baseBranch ?? "main";
    const header = root.createDiv({ cls: "oawm-changes-header" });
    const back = header.createEl("a", { text: "▲ ", href: "#" });
    back.onclick = (e) => { e.preventDefault(); void this.showTask(null); };
    header.createSpan({ text: `${task.title} · ${task.branch} → ${base}` });
    const refresh = header.createEl("button", { text: "⟳" });
    refresh.onclick = () => { void this.render(); };

    const tabs = root.createDiv({ cls: "oawm-changes-tabs" });
    const localFiles = await this.collect(task, "local");
    const unmergedFiles = await this.collect(task, "unmerged");
    this.tabButton(tabs, "local", `Local · ${localFiles.length}`);
    this.tabButton(tabs, "unmerged", `Unmerged · ${unmergedFiles.length}`);

    const body = root.createDiv({ cls: "oawm-changes-body" });
    if (this.tab === "local") this.renderLocal(body, task, localFiles);
    else this.renderUnmerged(body, task, unmergedFiles, base);
  }

  private tabButton(parent: HTMLElement, id: "local" | "unmerged", label: string) {
    const btn = parent.createEl("button", { text: label, cls: this.tab === id ? "oawm-tab-active" : "" });
    btn.onclick = () => { this.tab = id; void this.render(); };
  }

  private renderLocal(body: HTMLElement, task: TaskNote, files: FileChange[]) {
    if (files.length === 0) { body.createEl("em", { text: "No local changes" }); return; }
    for (const [repo, repoFiles] of groupByRepo(files)) {
      body.createEl("div", { cls: "oawm-changes-repo", text: `▸ ${repo}` });
      for (const f of repoFiles) {
        const row = body.createDiv({ cls: "oawm-changes-filerow" });
        const cb = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
        cb.checked = this.checked.has(this.key(repo, f.path));
        cb.onchange = () => { const k = this.key(repo, f.path); cb.checked ? this.checked.add(k) : this.checked.delete(k); this.updateCommitButtons(); };
        row.createSpan({ cls: `oawm-badge-${f.kind}`, text: f.kind });
        const link = row.createEl("a", { text: ` ${f.path}`, href: "#" });
        link.onclick = (e) => { e.preventDefault(); void this.openFileDiff(task, repo, f.path, "local"); };
        const pen = row.createEl("a", { text: " ✎", href: "#", cls: "oawm-pen" });
        pen.onclick = (e) => { e.preventDefault(); void this.deps.openEditor(task, repo, f.path); };
      }
    }
    const msg = body.createEl("textarea", { cls: "oawm-commit-msg", attr: { placeholder: "Commit message" } }) as HTMLTextAreaElement;
    msg.value = this.message;
    msg.oninput = () => { this.message = msg.value; this.updateCommitButtons(); };
    const btns = body.createDiv({ cls: "oawm-commit-btns" });
    this.commitPush = btns.createEl("button", { text: "Commit & Push" });
    this.commitOnly = btns.createEl("button", { text: "Commit" });
    this.commitPush.onclick = () => void this.doCommit(task, true);
    this.commitOnly.onclick = () => void this.doCommit(task, false);
    this.updateCommitButtons();
  }

  private commitPush?: HTMLButtonElement;
  private commitOnly?: HTMLButtonElement;
  private updateCommitButtons() {
    const enabled = commitEnabled(this.checked.size, this.message);
    if (this.commitPush) this.commitPush.disabled = !enabled;
    if (this.commitOnly) this.commitOnly.disabled = !enabled;
  }

  private async doCommit(task: TaskNote, push: boolean) {
    const paths = [...this.checked].map((k) => { const idx = k.indexOf("\0"); return { repo: k.slice(0, idx), path: k.slice(idx + 1) }; });
    await this.deps.commit.commit(task, { paths, message: this.message, push });
    this.checked.clear();
    this.message = "";
    await this.render();
  }

  private renderUnmerged(body: HTMLElement, task: TaskNote, files: FileChange[], base: string) {
    if (files.length === 0) body.createEl("em", { text: "No unmerged changes (branch matches base)" });
    for (const [repo, repoFiles] of groupByRepo(files)) {
      body.createEl("div", { cls: "oawm-changes-repo", text: `▸ ${repo}` });
      for (const f of repoFiles) {
        const row = body.createDiv({ cls: "oawm-changes-filerow" });
        row.createSpan({ cls: `oawm-badge-${f.kind}`, text: f.kind });
        const link = row.createEl("a", { text: ` ${f.path}`, href: "#" });
        link.onclick = (e) => { e.preventDefault(); void this.openFileDiff(task, repo, f.path, "unmerged"); };
        const pen = row.createEl("a", { text: " ✎", href: "#", cls: "oawm-pen" });
        pen.onclick = (e) => { e.preventDefault(); void this.deps.openEditor(task, repo, f.path); };
      }
    }
    const btns = body.createDiv({ cls: "oawm-commit-btns" });
    const merge = btns.createEl("button", { text: "Merge" });
    const mergePush = btns.createEl("button", { text: "Merge & Push" });
    const pr = btns.createEl("button", { text: "Open PR/MR" });
    merge.onclick = async () => { await this.deps.completion.merge(task, { push: false }); await this.showTask(null); };
    mergePush.onclick = async () => { await this.deps.completion.merge(task, { push: true }); await this.showTask(null); };
    pr.onclick = async () => { const { url } = await this.deps.completion.openPr(task); if (url) this.deps.openExternal(url); };
    if (task.repositories.length > 1) {
      body.createEl("em", { cls: "oawm-changes-caveat", text: `Merge integrates the primary repo (${task.repositories[0]}) only.` });
    }
  }

  private async openFileDiff(task: TaskNote, repo: string, path: string, scope: "local" | "unmerged") {
    const ws = await this.deps.vault.getWorkspace(task.workspace);
    if (!ws) return;
    const wt = resolveTaskWorktrees(task, ws).find((w) => w.repo === repo);
    if (!wt) return;
    const diff = await this.deps.git.fileDiff(wt.path, ws.baseBranch, path, scope === "local" ? "worktree" : "branch");
    await this.deps.openDiff(`${repo}/${path} (${scope})`, diff);
  }
}
