import { ItemView, WorkspaceLeaf } from "obsidian";
import type { VaultGateway, GitBackend } from "../core/ports";
import type { CompletionCoordinator } from "../core/completion";
import type { CommitCoordinator } from "../core/commit";
import { commitEnabled, type FileChange } from "../core/changes";
import { buildTargets, resolveBaseRef, type CheckoutTarget } from "../core/targets";

export const CHANGES_VIEW_TYPE = "oawm-changes";

export interface ChangesViewDeps {
  vault: VaultGateway;
  git: GitBackend;
  completion: CompletionCoordinator;
  commit: CommitCoordinator;
  pinnedBaseRefs: () => Record<string, string>;
  setBaseRef: (repoPath: string, ref: string | null) => Promise<void>;
  openDiff: (title: string, diff: string) => Promise<void>;
  openEditor: (dir: string, path: string, session: string | null) => Promise<void>;
  openExternal: (url: string) => void;
}

export class ChangesView extends ItemView {
  private activeTarget: { repo: string; path: string } | null = null;
  private tab: "local" | "diff" = "local";
  private checked = new Set<string>();   // file path within the active checkout
  private message = "";
  private baseRefEditing = false;
  private searchTimer?: number;

  constructor(leaf: WorkspaceLeaf, private deps: ChangesViewDeps) { super(leaf); }
  getViewType() { return CHANGES_VIEW_TYPE; }
  getDisplayText() { return "Workspace Changes"; }
  getIcon() { return "git-pull-request"; }

  async onOpen() { await this.render(); }

  /** Deep-link entry point: null → overview; a task path → its primary-repo worktree target. */
  async showTask(path: string | null) {
    this.resetDetailState();
    if (!path) { this.activeTarget = null; await this.render(); return; }
    const groups = await this.loadGroups();
    for (const list of groups.values()) {
      for (const t of list) {
        if (t.kind === "worktree" && t.taskPath === path) { this.activeTarget = { repo: t.repo, path: t.path }; await this.render(); return; }
      }
    }
    this.activeTarget = null;
    await this.render();
  }

  private async showTarget(target: CheckoutTarget) {
    this.resetDetailState();
    this.activeTarget = { repo: target.repo, path: target.path };
    await this.render();
  }

  private resetDetailState() {
    this.checked.clear();
    this.message = "";
    this.tab = "local";
    this.baseRefEditing = false;
  }

  private loadGroups() {
    return Promise.all([this.deps.vault.listTasks(), this.deps.vault.listWorkspaces()])
      .then(([tasks, workspaces]) => buildTargets(tasks, workspaces));
  }

  private findTarget(groups: Map<string, CheckoutTarget[]>, sel: { repo: string; path: string }): CheckoutTarget | null {
    for (const t of groups.get(sel.repo) ?? []) if (t.path === sel.path) return t;
    return null;
  }

  private async render() {
    const root = this.contentEl;
    root.empty();
    const groups = await this.loadGroups();
    if (!this.activeTarget) { await this.renderOverview(root, groups); return; }
    const target = this.findTarget(groups, this.activeTarget);
    if (!target) { this.activeTarget = null; await this.renderOverview(root, groups); return; }
    await this.renderTarget(root, target);
  }

  private async renderOverview(root: HTMLElement, groups: Map<string, CheckoutTarget[]>) {
    root.createEl("h4", { text: "Workspace Changes" });
    if (groups.size === 0) { root.createEl("em", { text: "No workspaces found." }); return; }
    const pinned = this.deps.pinnedBaseRefs();
    for (const [repo, targets] of groups) {
      root.createEl("div", { cls: "oawm-changes-repo", text: `▾ ${repo}` });
      for (const t of targets) {
        const row = root.createDiv({ cls: "oawm-changes-overrow" });
        const marker = t.kind === "base" ? "◆ " : "○ ";
        const label = t.kind === "base" ? t.branch : `${t.taskId} — ${t.taskTitle}`;
        const link = row.createEl("a", { text: marker + label, href: "#" });
        link.onclick = (e) => { e.preventDefault(); void this.showTarget(t); };
        const c = await this.countsFor(t, resolveBaseRef(t, pinned));
        row.createSpan({ cls: "oawm-changes-count", text: ` ● ${c.local} ↑ ${c.unmerged}` });
      }
    }
  }

  private async countsFor(target: CheckoutTarget, baseRef: string): Promise<{ local: number; unmerged: number }> {
    try { return await this.deps.git.unmergedCounts(target.path, baseRef); }
    catch { return { local: 0, unmerged: 0 }; }
  }

  private async collect(target: CheckoutTarget, scope: "local" | "diff", baseRef?: string): Promise<FileChange[]> {
    try {
      return scope === "local"
        ? await this.deps.git.status(target.path)
        : await this.deps.git.branchDiffFiles(target.path, baseRef!);
    } catch { return []; }
  }

  private async renderTarget(root: HTMLElement, target: CheckoutTarget) {
    const baseRef = resolveBaseRef(target, this.deps.pinnedBaseRefs());
    const header = root.createDiv({ cls: "oawm-changes-header" });
    const back = header.createEl("a", { text: "▲ ", href: "#" });
    back.onclick = (e) => { e.preventDefault(); void this.showTask(null); };
    const label = target.kind === "base" ? target.branch : `${target.taskId} — ${target.taskTitle}`;
    header.createSpan({ text: `${label} · ${target.branch}` });
    const refresh = header.createEl("button", { text: "⟳" });
    refresh.onclick = () => { void this.render(); };

    this.renderBaseRefControl(root, target, baseRef);

    const tabs = root.createDiv({ cls: "oawm-changes-tabs" });
    const localFiles = await this.collect(target, "local");
    const diffFiles = await this.collect(target, "diff", baseRef);
    this.tabButton(tabs, "local", `Local · ${localFiles.length}`);
    this.tabButton(tabs, "diff", `${baseRef} · ${diffFiles.length}`);

    const body = root.createDiv({ cls: "oawm-changes-body" });
    if (this.tab === "local") this.renderLocal(body, target, localFiles);
    else await this.renderDiff(body, target, diffFiles, baseRef);
  }

  private renderBaseRefControl(root: HTMLElement, target: CheckoutTarget, baseRef: string) {
    const bar = root.createDiv({ cls: "oawm-changes-baseref" });
    bar.createSpan({ text: "vs " });
    const btn = bar.createEl("a", { text: baseRef, href: "#" });
    btn.onclick = (e) => { e.preventDefault(); this.baseRefEditing = !this.baseRefEditing; void this.render(); };
    if (this.deps.pinnedBaseRefs()[target.repoPath]) {
      const useDefault = bar.createEl("a", { text: " (use default)", href: "#" });
      useDefault.onclick = async (e) => { e.preventDefault(); await this.deps.setBaseRef(target.repoPath, null); await this.render(); };
    }
    if (!this.baseRefEditing) return;
    const input = bar.createEl("input", { type: "text", attr: { placeholder: "Search branches…" } }) as HTMLInputElement;
    const results = bar.createDiv({ cls: "oawm-changes-baseref-results" });
    input.oninput = () => {
      const q = input.value.trim();
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(async () => {
        const refs = q.length < 1 ? [] : await this.deps.git.searchBranches(target.repoPath, q, 20);
        results.empty();
        for (const ref of refs) {
          const item = results.createEl("a", { text: ref, href: "#", cls: "oawm-changes-baseref-item" });
          item.onclick = async (e) => {
            e.preventDefault();
            await this.deps.setBaseRef(target.repoPath, ref);
            this.baseRefEditing = false;
            await this.render();
          };
        }
      }, 200);
    };
    input.focus();
  }

  private tabButton(parent: HTMLElement, id: "local" | "diff", label: string) {
    const btn = parent.createEl("button", { text: label, cls: this.tab === id ? "oawm-tab-active" : "" });
    btn.onclick = () => { this.tab = id; void this.render(); };
  }

  private renderLocal(body: HTMLElement, target: CheckoutTarget, files: FileChange[]) {
    if (files.length === 0) { body.createEl("em", { text: "No local changes" }); return; }
    for (const f of files) {
      const row = body.createDiv({ cls: "oawm-changes-filerow" });
      const cb = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = this.checked.has(f.path);
      cb.onchange = () => { cb.checked ? this.checked.add(f.path) : this.checked.delete(f.path); this.updateCommitButtons(); };
      row.createSpan({ cls: `oawm-badge-${f.kind}`, text: f.kind });
      const link = row.createEl("a", { text: ` ${f.path}`, href: "#" });
      link.onclick = (e) => { e.preventDefault(); void this.openFileDiff(target, f.path, "local"); };
      const pen = row.createEl("a", { text: " ✎", href: "#", cls: "oawm-pen" });
      pen.onclick = (e) => { e.preventDefault(); void this.deps.openEditor(target.path, f.path, target.session ?? null); };
    }
    const msg = body.createEl("textarea", { cls: "oawm-commit-msg", attr: { placeholder: "Commit message" } }) as HTMLTextAreaElement;
    msg.value = this.message;
    msg.oninput = () => { this.message = msg.value; this.updateCommitButtons(); };
    const btns = body.createDiv({ cls: "oawm-commit-btns" });
    this.commitPush = btns.createEl("button", { text: "Commit & Push" });
    this.commitOnly = btns.createEl("button", { text: "Commit" });
    this.commitPush.onclick = () => void this.doCommit(target, true);
    this.commitOnly.onclick = () => void this.doCommit(target, false);
    this.updateCommitButtons();
  }

  private commitPush?: HTMLButtonElement;
  private commitOnly?: HTMLButtonElement;
  private updateCommitButtons() {
    const enabled = commitEnabled(this.checked.size, this.message);
    if (this.commitPush) this.commitPush.disabled = !enabled;
    if (this.commitOnly) this.commitOnly.disabled = !enabled;
  }

  private async doCommit(target: CheckoutTarget, push: boolean) {
    await this.deps.commit.commitTarget(target, { paths: [...this.checked], message: this.message, push });
    this.checked.clear();
    this.message = "";
    await this.render();
  }

  private async renderDiff(body: HTMLElement, target: CheckoutTarget, files: FileChange[], baseRef: string) {
    if (files.length === 0) body.createEl("em", { text: `No changes vs ${baseRef}` });
    for (const f of files) {
      const row = body.createDiv({ cls: "oawm-changes-filerow" });
      row.createSpan({ cls: `oawm-badge-${f.kind}`, text: f.kind });
      const link = row.createEl("a", { text: ` ${f.path}`, href: "#" });
      link.onclick = (e) => { e.preventDefault(); void this.openFileDiff(target, f.path, "diff"); };
      const pen = row.createEl("a", { text: " ✎", href: "#", cls: "oawm-pen" });
      pen.onclick = (e) => { e.preventDefault(); void this.deps.openEditor(target.path, f.path, target.session ?? null); };
    }
    const btns = body.createDiv({ cls: "oawm-commit-btns" });
    if (target.kind === "worktree") {
      const task = target.taskPath ? await this.deps.vault.getTask(target.taskPath) : null;
      const merge = btns.createEl("button", { text: "Merge" });
      const mergePush = btns.createEl("button", { text: "Merge & Push" });
      const pr = btns.createEl("button", { text: "Open PR/MR" });
      merge.onclick = async () => { if (!task) return; await this.deps.completion.merge(task, { push: false }); await this.showTask(null); };
      mergePush.onclick = async () => { if (!task) return; await this.deps.completion.merge(task, { push: true }); await this.showTask(null); };
      pr.onclick = async () => { if (!task) return; const { url } = await this.deps.completion.openPr(task); if (url) this.deps.openExternal(url); };
      if (task && task.repositories.length > 1) {
        body.createEl("em", { cls: "oawm-changes-caveat", text: `Merge integrates the primary repo (${task.repositories[0]}) only.` });
      }
    } else {
      const push = btns.createEl("button", { text: "Push" });
      push.onclick = async () => { await this.deps.git.pushBase(target.path, target.branch); await this.render(); };
    }
  }

  private async openFileDiff(target: CheckoutTarget, path: string, scope: "local" | "diff") {
    const baseRef = resolveBaseRef(target, this.deps.pinnedBaseRefs());
    const diff = await this.deps.git.fileDiff(target.path, baseRef, path, scope === "local" ? "worktree" : "branch");
    await this.deps.openDiff(`${target.repo}/${path} (${scope === "local" ? "local" : baseRef})`, diff);
  }
}
