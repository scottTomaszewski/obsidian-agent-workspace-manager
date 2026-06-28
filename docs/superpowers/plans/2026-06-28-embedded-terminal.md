# Embedded Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run agent sessions inside an in-Obsidian terminal (xterm.js + node-pty), one leaf per task, as an alternative to spawning an external OS terminal window — with zellij kept underneath for persistence and a cleaned-up settings tab.

**Architecture:** `TerminalLauncher` (`src/backends/terminal.ts`) already separates *what command runs* from *where the window lives*. We inject the launcher into `ZellijBackend` and add a second implementation, `EmbeddedTerminalLauncher`, that opens an `ItemView` (`TerminalView`) hosting an xterm.js terminal backed by a `PtyBackend` (node-pty). A `terminalHost` setting selects external vs embedded at the composition root. All zellij layout/launch-script/`attach` logic is reused verbatim; `openPane`/`isAlive`/`kill` are untouched.

**Tech Stack:** TypeScript, Obsidian plugin API, esbuild, vitest. New deps: `@xterm/xterm`, `@xterm/addon-fit` (bundled), `@homebridge/node-pty-prebuilt-multiarch` (externalized native module).

## Global Constraints

- **Platforms:** Linux, macOS, Windows (all desktop). No mobile.
- **Layering:** decision logic stays pure in `src/core`/`src/domain` (unit-tested); `ItemView` DOM is thin and has **no node tests** — verify via `docs/MANUAL-TEST.md`. Backends return result objects, never throw to the UI; user-facing messages go through `Notifier`/`Notice`.
- **Ports/adapters:** a new side-effecting capability → add the method to an interface, implement in `src/backends/*`, extend the fake in `tests/fakes.ts` so it still satisfies the interface.
- **TDD:** for `src/core`/`src/domain`/`src/backends` work, write the failing test first.
- **zellij stays underneath** — never build a no-multiplexer / PTY-owns-the-agent mode. The embedded view is a viewport; closing it must not kill the agent session.
- **Done gate:** `npm run typecheck` clean + `npm test` green + `npm run build` emits `main.js`.
- **Native module name (verbatim):** `@homebridge/node-pty-prebuilt-multiarch`.
- **View type IDs (verbatim):** terminal view = `oawm-terminal`.

---

### Task 1: Inject the launcher into `ZellijBackend`; thread `key`/`title`

Refactor `ZellijBackend` to take an injected `TerminalLauncher` (instead of building its own `SpawnTerminalLauncher`), extend the launcher opts with `key`/`title`, and add a pure `labelFromSession` helper. No user-visible behavior change yet — `main.ts` still wires the external launcher.

**Files:**
- Modify: `src/backends/terminal.ts` (extend `TerminalLauncher.open` opts type)
- Modify: `src/backends/zellij.ts` (injected launcher; `labelFromSession`; pass `key`/`title`)
- Modify: `src/main.ts:70` (construct `SpawnTerminalLauncher`, pass to `ZellijBackend`)
- Test: `tests/zellij.test.ts` (extend)

**Interfaces:**
- Produces: `labelFromSession(session: string): string` (exported from `src/backends/zellij.ts`).
- Produces: `new ZellijBackend(launcher: TerminalLauncher, zellijBin?: string)`.
- Produces: `TerminalLauncher.open(inner: string[], opts?: { cwd?: string; env?: Record<string,string>; key?: string; title?: string }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/zellij.test.ts`:

```ts
import { ZellijBackend, labelFromSession } from "../src/backends/zellij";
import type { TerminalLauncher } from "../src/backends/terminal";

class FakeTerminalLauncher implements TerminalLauncher {
  calls: { inner: string[]; opts?: { cwd?: string; env?: Record<string,string>; key?: string; title?: string } }[] = [];
  async open(inner: string[], opts?: any) { this.calls.push({ inner, opts }); }
}

describe("labelFromSession", () => {
  it("strips the oawm- prefix", () => {
    expect(labelFromSession("oawm-DS-1")).toBe("DS-1");
  });
  it("leaves a non-prefixed name unchanged", () => {
    expect(labelFromSession("custom")).toBe("custom");
  });
});

describe("ZellijBackend with injected launcher", () => {
  it("create() opens a bash script keyed/titled by the session", async () => {
    const launcher = new FakeTerminalLauncher();
    const zb = new ZellijBackend(launcher, "/opt/zellij");
    await zb.create("oawm-DS-1", "/wt", "claude", { K: "v" });
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0].inner[0]).toBe("bash");
    expect(launcher.calls[0].opts?.key).toBe("oawm-DS-1");
    expect(launcher.calls[0].opts?.title).toBe("DS-1");
  });

  it("focus() reattaches keyed/titled by the session", async () => {
    const launcher = new FakeTerminalLauncher();
    const zb = new ZellijBackend(launcher, "/opt/zellij");
    await zb.focus("oawm-DS-1");
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0].opts?.key).toBe("oawm-DS-1");
    expect(launcher.calls[0].opts?.title).toBe("DS-1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/zellij.test.ts`
Expected: FAIL — `labelFromSession` not exported; `ZellijBackend` constructor still expects a `terminalCommand` string.

- [ ] **Step 3: Extend the `TerminalLauncher` opts type**

In `src/backends/terminal.ts`, change the interface:

```ts
export interface TerminalLauncher {
  open(
    inner: string[],
    opts?: { cwd?: string; env?: Record<string, string>; key?: string; title?: string },
  ): Promise<void>;
}
```

`SpawnTerminalLauncher.open` already destructures only `opts.cwd`/`opts.env`; it ignores `key`/`title` with no change.

- [ ] **Step 4: Refactor `ZellijBackend` to inject the launcher and pass key/title**

In `src/backends/zellij.ts`:

Add the helper near the top (after the imports):

```ts
/** Derive a short tab label from a session name: "oawm-DS-1" → "DS-1". */
export function labelFromSession(session: string): string {
  const prefix = "oawm-";
  return session.startsWith(prefix) ? session.slice(prefix.length) : session;
}
```

Replace the constructor:

```ts
export class ZellijBackend implements MuxBackend {
  private terminal: TerminalLauncher;
  private bin: string;

  constructor(launcher: TerminalLauncher, zellijBin: string = DEFAULT_ZELLIJ_BIN) {
    this.terminal = launcher;
    // The terminal emulator and Electron exec the binary by PATH lookup, where a
    // shell alias (e.g. for /opt/zellij) is not visible — so allow an explicit path.
    this.bin = zellijBin || DEFAULT_ZELLIJ_BIN;
  }
```

In `create(...)`, change the final `open` call:

```ts
    await this.terminal.open(["bash", scriptPath], {
      cwd, env, key: session, title: labelFromSession(session),
    });
```

In `focus(...)`, change the `open` call:

```ts
    await this.terminal.open(["bash", "-lc", script], {
      key: session, title: labelFromSession(session),
    });
```

Ensure `SpawnTerminalLauncher` is still imported (it is, via the existing `import { SpawnTerminalLauncher, type TerminalLauncher } from "./terminal";` — keep the `TerminalLauncher` type import; the `SpawnTerminalLauncher` value import is now unused here, so change it to `import type { TerminalLauncher } from "./terminal";`).

- [ ] **Step 5: Update the composition root**

In `src/main.ts`, add to the existing terminal import:

```ts
import { SpawnTerminalLauncher } from "./backends/terminal";
```

Replace line ~70:

```ts
    const launcher = new SpawnTerminalLauncher(this.settings.terminalCommand || DEFAULT_TERMINAL_COMMAND);
    this.mux = new ZellijBackend(launcher, this.settings.zellijPath);
```

(`DEFAULT_TERMINAL_COMMAND` is already imported in `main.ts`.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/zellij.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/backends/terminal.ts src/backends/zellij.ts src/main.ts tests/zellij.test.ts
git commit -m "refactor(terminal): inject launcher into ZellijBackend; thread key/title"
```

---

### Task 2: Add `PtyBackend` port + `NodePtyHost` adapter + `FakePty`

Define a PTY port, a node-pty adapter with an injectable spawn function (so the mapping is unit-testable without the native module), and a fake. Add the native dependency and externalize it in the build.

**Files:**
- Modify: `src/core/ports.ts` (add `PtyHandle`, `PtyBackend`)
- Create: `src/backends/pty.ts` (`NodePtyHost`, `RawPty`, `PtySpawn`)
- Modify: `tests/fakes.ts` (add `FakePty`)
- Modify: `tests/fakes.test.ts` (assert `FakePty` satisfies the port)
- Modify: `esbuild.config.mjs` (externalize the native module)
- Modify: `package.json` (add dependency)
- Test: `tests/pty.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  interface PtyHandle {
    onData(cb: (chunk: string) => void): void;
    onExit(cb: (code: number) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
  }
  interface PtyBackend {
    spawn(argv: string[], opts: { cwd?: string; env?: Record<string,string>; cols?: number; rows?: number }): PtyHandle;
  }
  ```
- Produces: `new NodePtyHost(ptySpawn?: PtySpawn)`.

- [ ] **Step 1: Install the native dependency**

Run: `npm install @homebridge/node-pty-prebuilt-multiarch`
Expected: package added to `package.json` `dependencies`; prebuilt binary present under `node_modules/@homebridge/node-pty-prebuilt-multiarch`.

- [ ] **Step 2: Write the failing test**

Create `tests/pty.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NodePtyHost, type RawPty } from "../src/backends/pty";

function makeStubPty() {
  return {
    file: "", args: [] as string[], opts: null as any,
    dataCb: null as null | ((d: string) => void),
    exitCb: null as null | ((e: { exitCode: number }) => void),
    writes: [] as string[], resizes: [] as [number, number][], killed: false,
    onData(cb: (d: string) => void) { this.dataCb = cb; },
    onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb; },
    write(d: string) { this.writes.push(d); },
    resize(c: number, r: number) { this.resizes.push([c, r]); },
    kill() { this.killed = true; },
  };
}

describe("NodePtyHost", () => {
  it("maps argv/opts to the spawn function and wires the handle", () => {
    const stub = makeStubPty();
    const spawn = (file: string, args: string[], opts: any): RawPty => {
      stub.file = file; stub.args = args; stub.opts = opts; return stub as unknown as RawPty;
    };
    const host = new NodePtyHost(spawn);
    const received: string[] = [];
    let exitCode = -1;
    const h = host.spawn(["bash", "-lc", "echo hi"], { cwd: "/wt", env: { K: "v" }, cols: 100, rows: 30 });
    h.onData((d) => received.push(d));
    h.onExit((c) => { exitCode = c; });

    expect(stub.file).toBe("bash");
    expect(stub.args).toEqual(["-lc", "echo hi"]);
    expect(stub.opts.cwd).toBe("/wt");
    expect(stub.opts.cols).toBe(100);
    expect(stub.opts.rows).toBe(30);
    expect(stub.opts.env.K).toBe("v");

    stub.dataCb!("hello");
    h.write("ls\n"); h.resize(120, 40); h.kill();
    stub.exitCb!({ exitCode: 7 });

    expect(received).toEqual(["hello"]);
    expect(stub.writes).toEqual(["ls\n"]);
    expect(stub.resizes).toEqual([[120, 40]]);
    expect(stub.killed).toBe(true);
    expect(exitCode).toBe(7);
  });

  it("defaults cols/rows when omitted", () => {
    const stub = makeStubPty();
    const host = new NodePtyHost((f, a, o) => { stub.opts = o; return stub as unknown as RawPty; });
    host.spawn(["bash"], {});
    expect(stub.opts.cols).toBe(80);
    expect(stub.opts.rows).toBe(24);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/pty.test.ts`
Expected: FAIL — `src/backends/pty.ts` does not exist.

- [ ] **Step 4: Add the port to `ports.ts`**

Append to `src/core/ports.ts`:

```ts
export interface PtyHandle {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtyBackend {
  spawn(
    argv: string[],
    opts: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number },
  ): PtyHandle;
}
```

- [ ] **Step 5: Implement `NodePtyHost`**

Create `src/backends/pty.ts`:

```ts
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
```

- [ ] **Step 6: Externalize the native module in esbuild**

In `esbuild.config.mjs`, change the `external` array:

```js
  external: ["obsidian", "electron", "@homebridge/node-pty-prebuilt-multiarch", ...builtins],
```

- [ ] **Step 7: Add `FakePty` to the fakes**

Append to `tests/fakes.ts`:

```ts
import type { PtyBackend, PtyHandle } from "../src/core/ports";

export class FakePty implements PtyBackend {
  spawns: { argv: string[]; opts: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number } }[] = [];
  dataCbs: ((c: string) => void)[] = [];
  exitCbs: ((code: number) => void)[] = [];
  writes: string[] = [];
  killed = false;
  spawn(argv: string[], opts: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number }): PtyHandle {
    this.spawns.push({ argv, opts });
    return {
      onData: (cb) => this.dataCbs.push(cb),
      onExit: (cb) => this.exitCbs.push(cb),
      write: (d) => this.writes.push(d),
      resize: () => {},
      kill: () => { this.killed = true; },
    };
  }
}
```

(Place the `import type` line with the other imports at the top of `tests/fakes.ts`.)

- [ ] **Step 8: Assert the fake satisfies the port**

Add to `tests/fakes.test.ts`:

```ts
it("pty fake records spawns and drives data/exit", async () => {
  const { FakePty } = await import("./fakes");
  const p = new FakePty();
  const got: string[] = [];
  let code = -1;
  const h = p.spawn(["bash"], { cwd: "/wt" });
  h.onData((d) => got.push(d));
  h.onExit((c) => { code = c; });
  p.dataCbs[0]("x");
  p.exitCbs[0](0);
  h.write("y"); h.kill();
  expect(p.spawns[0].argv).toEqual(["bash"]);
  expect(got).toEqual(["x"]);
  expect(code).toBe(0);
  expect(p.writes).toEqual(["y"]);
  expect(p.killed).toBe(true);
});
```

- [ ] **Step 9: Run tests + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green; `main.js` emitted; no attempt to bundle the native module.

- [ ] **Step 10: Commit**

```bash
git add src/core/ports.ts src/backends/pty.ts tests/pty.test.ts tests/fakes.ts tests/fakes.test.ts esbuild.config.mjs package.json package-lock.json
git commit -m "feat(pty): add PtyBackend port + NodePtyHost adapter + FakePty"
```

---

### Task 3: `TerminalView` (xterm.js) + registration + styles

Add the in-Obsidian terminal view. DOM code — **no node tests** (repo convention); verified manually. On spawn failure (including a missing/incompatible native binary), show the error in the pane and a `Notice` pointing at the External-window fallback.

**Files:**
- Create: `src/obsidian/terminalView.ts`
- Modify: `src/main.ts` (import; `this.pty`; `registerView`)
- Modify: `styles.css` (append xterm CSS)
- Modify: `docs/MANUAL-TEST.md` (add checks)
- Modify: `package.json` (add `@xterm/xterm`, `@xterm/addon-fit`)

**Interfaces:**
- Consumes: `PtyBackend`, `PtyHandle` from Task 2.
- Produces: `TERMINAL_VIEW_TYPE = "oawm-terminal"`; `class TerminalView extends ItemView` with `get key(): string | undefined` and `start(state: TerminalViewState): Promise<void>`.
- Produces: `interface TerminalViewState { key: string; argv: string[]; cwd?: string; env?: Record<string,string>; title: string }`.

- [ ] **Step 1: Install xterm**

Run: `npm install @xterm/xterm @xterm/addon-fit`
Expected: both added to `dependencies`.

- [ ] **Step 2: Create the view**

Create `src/obsidian/terminalView.ts`:

```ts
import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { PtyBackend, PtyHandle } from "../core/ports";

export const TERMINAL_VIEW_TYPE = "oawm-terminal";

export interface TerminalViewState {
  key: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  title: string;
}

export class TerminalView extends ItemView {
  private term?: Terminal;
  private fit?: FitAddon;
  private pty?: PtyHandle;
  private state?: TerminalViewState;

  constructor(leaf: WorkspaceLeaf, private ptyBackend: PtyBackend) { super(leaf); }

  getViewType() { return TERMINAL_VIEW_TYPE; }
  getDisplayText() { return this.state ? `Terminal: ${this.state.title}` : "OAWM Terminal"; }
  getIcon() { return "terminal"; }

  /** The session key this leaf is bound to; used to reveal an existing leaf. */
  get key(): string | undefined { return this.state?.key; }

  async start(state: TerminalViewState) {
    this.state = state;
    this.render();
  }

  private render() {
    if (!this.state) return;
    const el = this.contentEl;
    el.empty();
    el.addClass("oawm-terminal");

    const term = new Terminal({ convertEol: true, fontFamily: "monospace", fontSize: 13, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    this.term = term;
    this.fit = fit;

    const { argv, cwd, env } = this.state;
    let pty: PtyHandle;
    try {
      pty = this.ptyBackend.spawn(argv, { cwd, env, cols: term.cols, rows: term.rows });
    } catch (e) {
      term.write(`\r\n[oawm] could not start the embedded terminal: ${String(e)}\r\n`);
      new Notice("OAWM: embedded terminal failed to start. Update OAWM, or switch Terminal host to \"External window\" in settings.");
      return;
    }
    this.pty = pty;

    pty.onData((d) => term.write(d));
    term.onData((d) => pty.write(d));
    pty.onExit((code) => {
      term.write(`\r\n[oawm] session ended (exit ${code}). This pane is kept open so any error above is readable.\r\n`);
    });
    this.registerDomEvent(window, "resize", () => this.onResize());
  }

  onResize() {
    if (this.fit && this.term && this.pty) {
      this.fit.fit();
      this.pty.resize(this.term.cols, this.term.rows);
    }
  }

  async onClose() {
    // The detached zellij session survives; we only drop this viewport.
    this.pty?.kill();
    this.term?.dispose();
  }
}
```

- [ ] **Step 3: Register the view and construct the PTY backend**

In `src/main.ts`:

Add imports:

```ts
import { TerminalView, TERMINAL_VIEW_TYPE } from "./obsidian/terminalView";
import { NodePtyHost } from "./backends/pty";
```

Add a field on the plugin class (near `private mux!: ZellijBackend;`):

```ts
  private pty!: NodePtyHost;
```

In `onload()`, before the `registerView` calls, construct the backend:

```ts
    this.pty = new NodePtyHost();
```

Add a `registerView` call alongside the existing ones:

```ts
    this.registerView(TERMINAL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TerminalView(leaf, this.pty));
```

- [ ] **Step 4: Add xterm CSS to styles.css**

xterm requires its stylesheet. Append its contents to the plugin stylesheet (a single concatenation step — Obsidian loads only `styles.css`, and `@import` from `node_modules` will not resolve at runtime):

Run: `printf '\n/* --- @xterm/xterm base styles (copied; re-copy on xterm upgrade) --- */\n' >> styles.css && cat node_modules/@xterm/xterm/css/xterm.css >> styles.css`
Expected: `styles.css` grows by the xterm base styles.

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean; `main.js` emitted (xterm bundled in; native module external).

- [ ] **Step 6: Manual smoke (temporary)**

Temporarily add this to `onload()` to verify the view renders independently of the launcher, then remove it after checking:

```ts
    // TEMP smoke — remove after verifying:
    this.addCommand({ id: "oawm-temp-term", name: "OAWM temp terminal", callback: async () => {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, active: true });
      await (leaf.view as TerminalView).start({ key: "smoke", argv: ["bash"], title: "smoke" });
    }});
```

Reload the plugin in Obsidian, run the command, confirm: an interactive shell appears, you can type `ls`, resizing the pane reflows, exiting (`exit`) prints the "session ended" line and leaves the pane open. Then delete the TEMP block.

- [ ] **Step 7: Add manual-test entries**

Add to `docs/MANUAL-TEST.md` a "Embedded terminal" section:

```markdown
## Embedded terminal
- With Terminal host = Embedded, starting a task opens a terminal leaf running the agent.
- Typing works; resizing the pane reflows the terminal.
- Exiting the shell prints "[oawm] session ended …" and keeps the pane open.
- Closing the leaf does NOT kill the agent: "Open Terminal" re-attaches to the live zellij session.
- If the native terminal cannot load, a Notice points to the External-window fallback.
```

- [ ] **Step 8: Commit**

```bash
git add src/obsidian/terminalView.ts src/main.ts styles.css docs/MANUAL-TEST.md package.json package-lock.json
git commit -m "feat(terminal): add xterm.js TerminalView + registration"
```

---

### Task 4: `EmbeddedTerminalLauncher` + `terminalHost` setting + launcher selection

Add the launcher that opens/reveals a `TerminalView` leaf, add the `terminalHost` setting field with a minimal control, and select the launcher at the composition root. After this task, flipping the setting makes agents launch inside Obsidian. (Full settings-tab cleanup is Task 5.)

**Files:**
- Create: `src/obsidian/embeddedTerminal.ts`
- Modify: `src/main.ts` (settings interface + default; launcher selection; minimal setting control)
- Modify: `docs/MANUAL-TEST.md` (fallback check)

**Interfaces:**
- Consumes: `TERMINAL_VIEW_TYPE`, `TerminalView` (Task 3); `TerminalLauncher` (Task 1).
- Produces: `class EmbeddedTerminalLauncher implements TerminalLauncher`, constructed as `new EmbeddedTerminalLauncher(app)`.
- Produces: `OawmSettings.terminalHost: "embedded" | "external"` (default `"embedded"`).

- [ ] **Step 1: Create the launcher**

Create `src/obsidian/embeddedTerminal.ts`:

```ts
import type { App } from "obsidian";
import type { TerminalLauncher } from "../backends/terminal";
import { TERMINAL_VIEW_TYPE, TerminalView } from "./terminalView";

/**
 * TerminalLauncher that runs the command inside an in-Obsidian TerminalView leaf
 * (one leaf per session `key`) instead of an external OS terminal window. Reveals
 * an existing leaf for the same key rather than opening a duplicate.
 */
export class EmbeddedTerminalLauncher implements TerminalLauncher {
  constructor(private app: App) {}

  async open(
    inner: string[],
    opts: { cwd?: string; env?: Record<string, string>; key?: string; title?: string } = {},
  ): Promise<void> {
    const key = opts.key ?? inner.join(" ");
    const existing = this.app.workspace
      .getLeavesOfType(TERMINAL_VIEW_TYPE)
      .find((l) => (l.view as TerminalView).key === key);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    await (leaf.view as TerminalView).start({
      key,
      argv: inner,
      cwd: opts.cwd,
      env: opts.env,
      title: opts.title ?? key,
    });
  }
}
```

- [ ] **Step 2: Add the setting field + default**

In `src/main.ts`, extend the `OawmSettings` interface:

```ts
  terminalHost: "embedded" | "external";
```

and `DEFAULT_SETTINGS`:

```ts
  terminalHost: "embedded",
```

- [ ] **Step 3: Select the launcher at the composition root**

In `src/main.ts`, add the import:

```ts
import { EmbeddedTerminalLauncher } from "./obsidian/embeddedTerminal";
```

Replace the launcher construction from Task 1 (Step 5) with:

```ts
    const launcher = this.settings.terminalHost === "embedded"
      ? new EmbeddedTerminalLauncher(this.app)
      : new SpawnTerminalLauncher(this.settings.terminalCommand || DEFAULT_TERMINAL_COMMAND);
    this.mux = new ZellijBackend(launcher, this.settings.zellijPath);
```

Ensure `this.pty = new NodePtyHost();` and the `registerView(TERMINAL_VIEW_TYPE, …)` call (Task 3) run **before** this, so an embedded launch has a registered view. (They already sit earlier in `onload()`.)

- [ ] **Step 4: Add a minimal setting control**

In `OawmSettingTab.display()`, add (above the existing "Terminal command" setting) a dropdown so the host is switchable; the full grouped cleanup comes in Task 5:

```ts
    new Setting(containerEl)
      .setName("Terminal host")
      .setDesc("Where agent terminals open. \"Embedded\" runs them inside Obsidian; \"External window\" spawns a terminal emulator. Takes effect on the next plugin reload.")
      .addDropdown((d) =>
        d.addOption("embedded", "Embedded").addOption("external", "External window")
          .setValue(this.plugin.settings.terminalHost)
          .onChange(async (v) => { this.plugin.settings.terminalHost = v as "embedded" | "external"; await this.plugin.saveData(this.plugin.settings); }));
```

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean; `main.js` emitted.

- [ ] **Step 6: Manual verification**

Reload the plugin in Obsidian. With **Terminal host = Embedded**, start a task → an `oawm-terminal` leaf opens running the agent in zellij. Click **Open Terminal** again → the same leaf is revealed (no duplicate). Close the leaf, then **Open Terminal** → a new leaf re-attaches to the still-alive session. Switch to **External window**, reload, start a task → behavior matches the pre-change external-window flow.

- [ ] **Step 7: Commit**

```bash
git add src/obsidian/embeddedTerminal.ts src/main.ts
git commit -m "feat(terminal): EmbeddedTerminalLauncher + terminalHost setting"
```

---

### Task 5: Settings tab cleanup (grouping + conditional rendering + rename)

Reorganize `OawmSettingTab.display()` into headed groups, render the two "command" fields only when their mode is active, and relabel "Zellij path" → "Multiplexer path". DOM — verified manually.

**Files:**
- Modify: `src/main.ts` (`OawmSettingTab.display()`)
- Modify: `docs/MANUAL-TEST.md` (settings checks)

**Interfaces:**
- Consumes: `OawmSettings` incl. `terminalHost` (Task 4). No new exports.

- [ ] **Step 1: Rewrite `display()` with groups + conditional fields**

Replace the entire body of `OawmSettingTab.display()` in `src/main.ts` with:

```ts
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveData(s);

    // --- Agent terminal ---
    new Setting(containerEl).setName("Agent terminal").setHeading();

    new Setting(containerEl)
      .setName("Terminal host")
      .setDesc("Where agent terminals open. \"Embedded\" runs them inside Obsidian; \"External window\" spawns a terminal emulator. Takes effect on the next plugin reload.")
      .addDropdown((d) =>
        d.addOption("embedded", "Embedded").addOption("external", "External window")
          .setValue(s.terminalHost)
          .onChange(async (v) => { s.terminalHost = v as "embedded" | "external"; await save(); this.display(); }));

    if (s.terminalHost === "external") {
      new Setting(containerEl)
        .setName("Terminal command")
        .setDesc("Terminal emulator used to launch and attach to agent sessions. The session command is appended after this prefix. Examples: \"gnome-terminal --\", \"konsole -e\", \"xterm -e\", \"alacritty -e\", \"kitty\", \"wezterm start --\". Takes effect on the next plugin reload.")
        .addText((t) =>
          t.setPlaceholder(DEFAULT_TERMINAL_COMMAND).setValue(s.terminalCommand)
            .onChange(async (v) => { s.terminalCommand = v.trim() || DEFAULT_TERMINAL_COMMAND; await save(); }));
    }

    new Setting(containerEl)
      .setName("Multiplexer path")
      .setDesc("Path to the zellij binary. Use an absolute path (e.g. \"/opt/zellij\") if zellij is not on PATH for non-interactive processes — a shell alias in ~/.bashrc is not visible here. Takes effect on the next plugin reload.")
      .addText((t) =>
        t.setPlaceholder(DEFAULT_ZELLIJ_BIN).setValue(s.zellijPath)
          .onChange(async (v) => { s.zellijPath = v.trim() || DEFAULT_ZELLIJ_BIN; await save(); }));

    // --- Editor ---
    new Setting(containerEl).setName("Editor").setHeading();

    new Setting(containerEl)
      .setName("Open strategy")
      .setDesc("How the ✎ affordance opens a file. \"Terminal pane\" opens it in a new pane in the task's zellij session (works over SSH); \"External command\" spawns a GUI editor command.")
      .addDropdown((d) =>
        d.addOption("mux", "Terminal pane (zellij)").addOption("external", "External command")
          .setValue(s.editorStrategy)
          .onChange(async (v) => { s.editorStrategy = v as "mux" | "external"; await save(); this.display(); }));

    if (s.editorStrategy === "external") {
      new Setting(containerEl)
        .setName("Editor command")
        .setDesc("Command template with {file} and {line} placeholders. Examples: \"nvim +{line} {file}\", \"glow {file}\", \"code -g {file}:{line}\".")
        .addText((t) =>
          t.setPlaceholder("nvim +{line} {file}").setValue(s.editorCommand)
            .onChange(async (v) => { s.editorCommand = v; await save(); }));
    }

    // --- Diff ---
    new Setting(containerEl).setName("Diff").setHeading();

    new Setting(containerEl)
      .setName("Diff window")
      .setDesc("Where file diffs open. \"Popout\" opens a separate window so you can read a diff while referencing code in the main window; \"Split\" opens in the main editor area; \"New tab\" opens a tab alongside your notes.")
      .addDropdown((d) =>
        d.addOption("popout", "Popout window").addOption("split", "Main split").addOption("tab", "New tab")
          .setValue(s.diffTarget)
          .onChange(async (v) => { s.diffTarget = v as DiffTarget; await save(); }));
  }
```

(This replaces the standalone Task 4 "Terminal host" control and folds it into the grouped layout. The `editorStrategy` dropdown now also re-renders so "Editor command" shows only in external mode.)

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean; `main.js` emitted.

- [ ] **Step 3: Manual verification**

Reload the plugin, open settings. Confirm three headings (Agent terminal / Editor / Diff). Switching **Terminal host** to External reveals "Terminal command"; switching back to Embedded hides it. Switching **Open strategy** to External command reveals "Editor command"; back to Terminal pane hides it. The multiplexer field reads "Multiplexer path". Values persist across reload.

- [ ] **Step 4: Add manual-test entries**

Add to `docs/MANUAL-TEST.md`:

```markdown
## Settings groups
- Settings show three headings: Agent terminal, Editor, Diff.
- "Terminal command" appears only when Terminal host = External window.
- "Editor command" appears only when Open strategy = External command.
- Multiplexer path persists across reload.
```

- [ ] **Step 5: Commit**

```bash
git add src/main.ts docs/MANUAL-TEST.md
git commit -m "feat(settings): group settings, conditional fields, rename to Multiplexer path"
```

---

### Task 6: Packaging & release — ship and validate the native module

The native module must reach the user's plugin folder and load against Obsidian's Electron ABI. This task validates loading and updates release tooling. Mostly manual/config; gated before any release.

**Files:**
- Modify: `justfile` (release recipe — include the native module)
- Modify: `docs/gotchas.md` (packaging/ABI note)

- [ ] **Step 1: Identify Obsidian's Electron ABI**

In Obsidian, open the developer console (Ctrl/Cmd-Shift-I) and run:

```js
process.versions.electron; process.versions.modules
```

Record both. `process.versions.modules` is the `NODE_MODULE_VERSION` the prebuilt `.node` must match.

- [ ] **Step 2: Confirm the installed prebuild matches**

Run: `ls node_modules/@homebridge/node-pty-prebuilt-multiarch/prebuilds`
Confirm a build exists for the current platform/arch and that `@homebridge/node-pty-prebuilt-multiarch` ships a prebuild for the recorded `modules` ABI. If not, note which Electron the bundled prebuild targets — this determines the `minAppVersion` you can support.

- [ ] **Step 3: Validate loading in a real vault (Embedded host)**

With the dev build symlinked/copied into a test vault's `.obsidian/plugins/oawm/` (including `node_modules/@homebridge/node-pty-prebuilt-multiarch`), reload Obsidian, set Terminal host = Embedded, and start a task. Confirm a working shell (no load-failure Notice). If the Notice fires, the ABI/prebuild does not match — resolve before proceeding.

- [ ] **Step 4: Update the release recipe to ship the native module**

The community-release assets are loose files (`main.js manifest.json styles.css`), which cannot carry a native module. Distribute the plugin as a folder/zip including the native module so `require("@homebridge/node-pty-prebuilt-multiarch")` resolves from the plugin dir.

In `justfile`, before `gh release create`, build a self-contained plugin directory and zip it:

```bash
	# Assemble a self-contained plugin folder including the native terminal module,
	# which the loose-file assets cannot carry. node-pty is required at runtime by
	# main.js and resolves from the plugin's node_modules.
	rm -rf dist-plugin && mkdir -p dist-plugin/node_modules
	cp main.js manifest.json styles.css dist-plugin/
	cp -R node_modules/@homebridge dist-plugin/node_modules/
	( cd dist-plugin && zip -r ../oawm-"$version".zip . )
```

and add `oawm-"$version".zip` to the `gh release create` asset list:

```bash
	gh release create "$version" \
		--title "$version" \
		--target "$(git rev-parse --abbrev-ref HEAD)" \
		--notes "$notes" \
		main.js manifest.json styles.css oawm-"$version".zip
```

(Manual/BRAT install: unzip into `<vault>/.obsidian/plugins/oawm/`. Note in the release notes that the embedded terminal requires the zip, not the loose files.)

- [ ] **Step 5: Document the gotcha**

Add to `docs/gotchas.md`:

```markdown
## Embedded terminal: native module packaging & ABI
- The embedded terminal needs a real PTY via `@homebridge/node-pty-prebuilt-multiarch`,
  a native module. It is `external` in esbuild and `require`d at runtime, so it must sit
  in the plugin's `node_modules` — hence the release ships a self-contained zip, not just
  the loose `main.js/manifest/styles`.
- The prebuilt `.node` must match Obsidian's Electron ABI (`process.versions.modules`).
  After an Obsidian Electron bump, re-validate (Task 6 steps) and re-release if needed.
- xterm's CSS is copied into `styles.css` (no runtime `@import` from node_modules); re-copy
  on xterm upgrades.
- zellij stays the persistence spine: the TerminalView is only a viewport. Closing the leaf
  kills the attached PTY, not the detached zellij session — "Open Terminal" re-attaches.
```

- [ ] **Step 6: Commit**

```bash
git add justfile docs/gotchas.md
git commit -m "build(release): ship node-pty in a self-contained plugin zip; document ABI"
```

---

### Task 7: Architecture docs + tmux follow-up

Keep the docs true (sync agreement) and record the deferred tmux backend.

**Files:**
- Modify: `ARCHITECTURE.md` (module map)
- Modify: `ROADMAP.md` or `FOLLOWUPS.md` (tmux entry)
- Modify: `CHANGELOG.md` (Unreleased bullet)

- [ ] **Step 1: Update the module map**

In `ARCHITECTURE.md`, add to the module map: `src/obsidian/terminalView.ts` (xterm.js `ItemView`, one leaf per session), `src/obsidian/embeddedTerminal.ts` (`EmbeddedTerminalLauncher`), `src/backends/pty.ts` (`PtyBackend`/`NodePtyHost`). Note the injected-`TerminalLauncher` seam on `ZellijBackend` and the `terminalHost` setting selecting external vs embedded at the composition root.

- [ ] **Step 2: Record the tmux follow-up**

Add a numbered section to `ROADMAP.md` (use its numbering convention): a tmux `MuxBackend` adapter implementing the existing `MuxBackend` port (`new-session`/`attach-session`/`list-sessions`/`kill-session`/`split-window`), selectable alongside zellij. Note it composes with the embedded terminal with no further changes.

- [ ] **Step 3: Add a changelog bullet**

Under `## Unreleased` in `CHANGELOG.md`:

```markdown
- Embedded terminal: run agent sessions inside Obsidian (xterm.js + node-pty) via the new "Terminal host: Embedded" setting; settings tab regrouped.
```

- [ ] **Step 4: Final gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, tests green, `main.js` emitted.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md ROADMAP.md CHANGELOG.md
git commit -m "docs: map embedded terminal modules; record tmux follow-up"
```

---

## Self-Review

**Spec coverage:**
- Embedded terminal / one leaf per task → Tasks 3, 4. ✓
- node-pty + prebuilt binaries → Tasks 2, 6. ✓
- zellij stays underneath; create/focus reuse launch script → Task 1 (launcher seam), unchanged `openPane`/`isAlive`/`kill`. ✓
- `key`/`title` opts on `TerminalLauncher` → Task 1. ✓
- `PtyBackend` port + `NodePtyHost` + `FakePty` → Task 2. ✓
- `terminalHost` setting, default embedded, launcher selection at root → Task 4. ✓
- Settings cleanup (grouping, conditional fields, "Multiplexer path") → Task 5. ✓
- Exit-keeps-pane-open + load-failure Notice → Task 3. ✓
- Packaging/release + ABI validation → Task 6. ✓
- Docs (ARCHITECTURE/gotchas/MANUAL-TEST) + tmux follow-up → Tasks 3, 5, 6, 7. ✓
- Out-of-scope items (tmux build, no-mux mode, leaf auto-restore, internal tab bar, diffLayout/diffWrap UI) → not implemented. ✓

**Deviation from spec (noted):** the spec said leaf title = "task name". The `MuxBackend.create`/`focus` signatures carry only the session, not the task name, so the title is derived from the session via `labelFromSession` (`oawm-DS-1` → `DS-1`). Threading the real task name would require a `MuxBackend` port signature change rippling to `FakeMux`/`ClaudeBackend`; deferred as not worth the churn for v1. If the real title is wanted, it's a small follow-up.

**Placeholder scan:** no TBD/TODO; every code step shows full code; every test step shows assertions and the run command with expected result.

**Type consistency:** `PtyHandle`/`PtyBackend` (Task 2) are used identically in `NodePtyHost`, `FakePty`, `TerminalView`; `TerminalViewState` fields (`key/argv/cwd/env/title`) match between `TerminalView.start` (Task 3) and `EmbeddedTerminalLauncher.open` (Task 4); `TerminalLauncher.open` opts (`cwd/env/key/title`) match across Tasks 1, 4; `TERMINAL_VIEW_TYPE = "oawm-terminal"` consistent across Tasks 3, 4; `terminalHost: "embedded" | "external"` consistent across Tasks 4, 5.
