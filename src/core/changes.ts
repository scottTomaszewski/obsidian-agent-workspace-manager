export type ChangeKind = "M" | "A" | "D" | "R" | "?";

export interface FileChange {
  path: string;   // path relative to the worktree root
  repo: string;   // repo name; "" when produced by a parser (caller stamps it)
  staged: boolean;
  kind: ChangeKind;
}

/** Parse `git status --porcelain` (v1). `XY path`, `?? path`, rename `R  old -> new`. */
export function parseStatus(porcelain: string): FileChange[] {
  const out: FileChange[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.trim().length === 0) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    if (line.startsWith("??")) {
      out.push({ path: rest, repo: "", staged: false, kind: "?" });
      continue;
    }
    const isRename = x === "R" || y === "R";
    if (isRename) {
      const arrow = rest.indexOf(" -> ");
      if (arrow !== -1) rest = rest.slice(arrow + 4);
    }
    const staged = x !== " " && x !== "?";
    let kind: ChangeKind;
    if (isRename) kind = "R";
    else if (x === "A") kind = "A";
    else if (x === "D" || y === "D") kind = "D";
    else kind = "M";
    out.push({ path: rest, repo: "", staged, kind });
  }
  return out;
}

/** Parse `git diff --name-status`. `M\tpath`, `A\tpath`, `D\tpath`, `R100\told\tnew`. */
export function parseNameStatus(out: string): FileChange[] {
  const result: FileChange[] = [];
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) continue;
    const cols = line.split("\t");
    const code = cols[0][0];
    let kind: ChangeKind;
    let path: string;
    if (code === "R") { kind = "R"; path = cols[2]; }
    else if (code === "A") { kind = "A"; path = cols[1]; }
    else if (code === "D") { kind = "D"; path = cols[1]; }
    else { kind = "M"; path = cols[1]; }
    result.push({ path, repo: "", staged: false, kind });
  }
  return result;
}

export function groupByRepo(files: FileChange[]): Map<string, FileChange[]> {
  const g = new Map<string, FileChange[]>();
  for (const f of files) {
    const arr = g.get(f.repo) ?? [];
    arr.push(f);
    g.set(f.repo, arr);
  }
  return g;
}

export function kindBadge(kind: ChangeKind): string {
  return kind;
}

export function commitEnabled(checkedCount: number, message: string): boolean {
  return checkedCount > 0 && message.trim().length > 0;
}

export type SelectAllState = "none" | "some" | "all";

export function selectAllState(total: number, checked: number): SelectAllState {
  if (checked === 0 || total === 0) return "none";
  if (checked >= total) return "all";
  return "some";
}

export function stampRepo(files: FileChange[], repo: string): FileChange[] {
  return files.map((f) => ({ ...f, repo }));
}
