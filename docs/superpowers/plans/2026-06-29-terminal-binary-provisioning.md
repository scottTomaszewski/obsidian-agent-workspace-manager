# Terminal Native-Binary Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedded terminal's native `node-pty` dependency install on every plugin install path (community store, BRAT, manual) by downloading the ABI-stable binary at runtime, verified by SHA-256 and loaded by absolute path.

**Architecture:** Pure decision logic in `src/core/terminalBinary.ts` (asset names, URL building, checksum compare, install-state check). A `PtyProvisioner` port (`src/core/ports.ts`) implemented by `src/backends/ptyBinary.ts` (`NodePtyProvisioner`) does the fetch/verify/extract via fully-injected dependencies. `src/backends/pty.ts` loads node-pty by absolute path. `src/obsidian/terminalView.ts` shows a one-click in-pane install prompt when the binary is missing. A GitHub Actions matrix publishes per-platform binaries + `checksums.json` on each release.

**Tech Stack:** TypeScript, esbuild (CJS bundle, `node-pty` external), Obsidian API (`requestUrl`), Vitest, mainline `node-pty@^1.1.0` (N-API), GitHub Actions.

## Global Constraints

- **node-pty version:** `node-pty@^1.1.0` (mainline, N-API). Replaces `@homebridge/node-pty-prebuilt-multiarch`. Stays `external` in esbuild.
- **Repo slug (download source):** `scottTomaszewski/obsidian-agent-workspace-manager`.
- **Download tag:** the plugin's own version, `VERSION` from `src/version.ts` (currently `0.0.22`). URLs: `https://github.com/<repo>/releases/download/<VERSION>/<asset>`.
- **Asset naming:** `node-pty-<process.platform>-<process.arch>.zip`; checksum manifest `checksums.json` mapping `<asset> → <sha256 hex>`.
- **Checksum verification is mandatory:** abort if `checksums.json` is missing, lacks the asset entry, or the SHA-256 does not match. Never extract unverified bytes.
- **Binary install dir:** `<pluginDir>/node_modules/node-pty`, where `pluginDir = join(vaultRoot, manifest.dir)`.
- **Layering (CLAUDE.md):** pure logic in `core` (unit-tested first, TDD); side effects in `backends` returning result objects, never throwing to UI; `ItemView` DOM stays thin and has **no node tests** (verify via typecheck/build + `docs/MANUAL-TEST.md`). User-facing messages go through the pane / `Notifier`.
- **Default terminal host stays `"embedded"`;** "External window" remains the no-binary fallback.
- **Done gate (every task that touches TS):** `npm run typecheck` clean + `npm test` green + `npm run build` emits `main.js`.
- **Commits:** no Claude/AI attribution trailers. Work on branch `oawm/terminal-binary-provisioning`.

---

### Task 1: Pure core module + provisioner port

**Files:**
- Create: `src/core/terminalBinary.ts`
- Modify: `src/core/ports.ts` (append the `PtyProvisioner` port)
- Test: `tests/terminalBinary.test.ts`

**Interfaces:**
- Produces:
  - `type BinaryListing = { hasEntryJs: boolean; hasPrebuild: boolean; hasSpawnHelper: boolean; hasWinPatch: boolean }`
  - `assetNameFor(platform: string, arch: string): string`
  - `downloadUrls(repo: string, version: string, asset: string): { checksums: string; asset: string }`
  - `verifyChecksum(actualHex: string, expectedHex: string): boolean`
  - `isInstalled(listing: BinaryListing, platform: string): boolean`
  - `type PtyProvisionState = "ready" | "not-installed" | "downloading" | "error"`
  - `interface PtyProvisioner { status(): Promise<{ state: PtyProvisionState; message?: string }>; install(onProgress?: (msg: string) => void): Promise<{ ok: boolean; message: string }>; remove(): Promise<void>; binaryDir(): string }`

- [ ] **Step 1: Write the failing test**

Create `tests/terminalBinary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  assetNameFor, downloadUrls, verifyChecksum, isInstalled,
  type BinaryListing,
} from "../src/core/terminalBinary";

const REPO = "scottTomaszewski/obsidian-agent-workspace-manager";

describe("assetNameFor", () => {
  it("builds <platform>-<arch> zip names", () => {
    expect(assetNameFor("linux", "x64")).toBe("node-pty-linux-x64.zip");
    expect(assetNameFor("darwin", "arm64")).toBe("node-pty-darwin-arm64.zip");
    expect(assetNameFor("win32", "x64")).toBe("node-pty-win32-x64.zip");
  });
});

describe("downloadUrls", () => {
  it("pins to the release tag for both checksums and asset", () => {
    const u = downloadUrls(REPO, "0.0.22", "node-pty-linux-x64.zip");
    expect(u.checksums).toBe(`https://github.com/${REPO}/releases/download/0.0.22/checksums.json`);
    expect(u.asset).toBe(`https://github.com/${REPO}/releases/download/0.0.22/node-pty-linux-x64.zip`);
  });
});

describe("verifyChecksum", () => {
  it("matches case-insensitively and rejects mismatches", () => {
    expect(verifyChecksum("ABCD", "abcd")).toBe(true);
    expect(verifyChecksum("abcd", "ef01")).toBe(false);
  });
});

describe("isInstalled", () => {
  const base: BinaryListing = { hasEntryJs: true, hasPrebuild: true, hasSpawnHelper: true, hasWinPatch: true };
  it("requires entry js + prebuild on all platforms", () => {
    expect(isInstalled({ ...base, hasEntryJs: false }, "linux")).toBe(false);
    expect(isInstalled({ ...base, hasPrebuild: false }, "linux")).toBe(false);
  });
  it("requires spawn-helper on unix, patch on win32", () => {
    expect(isInstalled({ ...base, hasSpawnHelper: false }, "linux")).toBe(false);
    expect(isInstalled({ ...base, hasSpawnHelper: false }, "win32")).toBe(true);
    expect(isInstalled({ ...base, hasWinPatch: false }, "win32")).toBe(false);
    expect(isInstalled({ ...base, hasWinPatch: false }, "darwin")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/terminalBinary.test.ts`
Expected: FAIL — `Cannot find module "../src/core/terminalBinary"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/core/terminalBinary.ts`:

```ts
/** What's physically present in <pluginDir>/node_modules/node-pty, as seen by an adapter. */
export interface BinaryListing {
  hasEntryJs: boolean;     // lib/index.js
  hasPrebuild: boolean;    // any *.node under prebuilds/<plat>-<arch>/ or build/Release/
  hasSpawnHelper: boolean; // unix: prebuilds/<plat>-<arch>/spawn-helper
  hasWinPatch: boolean;    // win32: lib/windowsConoutConnection.js (our patched copy)
}

export function assetNameFor(platform: string, arch: string): string {
  return `node-pty-${platform}-${arch}.zip`;
}

export function downloadUrls(repo: string, version: string, asset: string): { checksums: string; asset: string } {
  const base = `https://github.com/${repo}/releases/download/${version}`;
  return { checksums: `${base}/checksums.json`, asset: `${base}/${asset}` };
}

export function verifyChecksum(actualHex: string, expectedHex: string): boolean {
  return actualHex.toLowerCase() === expectedHex.toLowerCase();
}

export function isInstalled(listing: BinaryListing, platform: string): boolean {
  if (!listing.hasEntryJs || !listing.hasPrebuild) return false;
  if (platform === "win32") return listing.hasWinPatch;
  return listing.hasSpawnHelper;
}
```

- [ ] **Step 4: Append the port to `src/core/ports.ts`**

Add at the end of `src/core/ports.ts` (after the `PtyBackend` interface, ~line 70):

```ts
export type PtyProvisionState = "ready" | "not-installed" | "downloading" | "error";

export interface PtyProvisioner {
  status(): Promise<{ state: PtyProvisionState; message?: string }>;
  install(onProgress?: (msg: string) => void): Promise<{ ok: boolean; message: string }>;
  remove(): Promise<void>;
  binaryDir(): string; // absolute path to <pluginDir>/node_modules/node-pty
}
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `npx vitest run tests/terminalBinary.test.ts && npm run typecheck`
Expected: PASS (all `terminalBinary` tests green; typecheck clean).

- [ ] **Step 6: Commit**

```bash
git add src/core/terminalBinary.ts src/core/ports.ts tests/terminalBinary.test.ts
git commit -m "feat(terminal): pure binary-provisioning helpers + PtyProvisioner port"
```

---

### Task 2: `NodePtyProvisioner` adapter

**Files:**
- Create: `src/backends/ptyBinary.ts`
- Test: `tests/ptyBinary.test.ts`

**Interfaces:**
- Consumes (Task 1): `assetNameFor`, `downloadUrls`, `verifyChecksum`, `isInstalled`, `BinaryListing`, `PtyProvisioner`, `PtyProvisionState`.
- Produces:
  - `interface ProvisionFetch { (url: string): Promise<{ json(): unknown; bytes(): Uint8Array }> }`
  - `interface ProvisionFs { exists(p: string): boolean; mkdir(p: string): void; writeFile(p: string, data: Uint8Array | string): void; rm(p: string): void; chmod(p: string, mode: number): void; listing(nodePtyDir: string, platform: string, arch: string): BinaryListing }`
  - `interface NodePtyProvisionerDeps { pluginDir: string; repo: string; version: string; platform: string; arch: string; patchText: string; join(...parts: string[]): string; fetch: ProvisionFetch; fs: ProvisionFs; extract(zipPath: string, destDir: string): Promise<void>; sha256(bytes: Uint8Array): string }`
  - `class NodePtyProvisioner implements PtyProvisioner` (constructed with `NodePtyProvisionerDeps`)

- [ ] **Step 1: Write the failing test**

Create `tests/ptyBinary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NodePtyProvisioner, type NodePtyProvisionerDeps } from "../src/backends/ptyBinary";
import type { BinaryListing } from "../src/core/terminalBinary";

/** In-memory fs that records writes and reports a listing we control. */
function makeFs(initialListing: BinaryListing) {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const removed: string[] = [];
  const chmods: [string, number][] = [];
  let listing = initialListing;
  return {
    files, removed, chmods,
    setListing(l: BinaryListing) { listing = l; },
    api: {
      exists: (p: string) => files.has(p) || dirs.has(p),
      mkdir: (p: string) => { dirs.add(p); },
      writeFile: (p: string, _d: Uint8Array | string) => { files.add(p); },
      rm: (p: string) => { removed.push(p); files.delete(p); dirs.delete(p); },
      chmod: (p: string, mode: number) => { chmods.push([p, mode]); },
      listing: () => listing,
    },
  };
}

const NOT_INSTALLED: BinaryListing = { hasEntryJs: false, hasPrebuild: false, hasSpawnHelper: false, hasWinPatch: false };

function baseDeps(over: Partial<NodePtyProvisionerDeps> & { fsh: ReturnType<typeof makeFs> }): NodePtyProvisionerDeps {
  const { fsh, ...rest } = over;
  return {
    pluginDir: "/plugin", repo: "owner/repo", version: "9.9.9",
    platform: "linux", arch: "x64", patchText: "PATCH",
    join: (...parts: string[]) => parts.join("/"),
    fetch: async (url: string) => {
      if (url.endsWith("checksums.json")) return { json: () => ({ "node-pty-linux-x64.zip": "deadbeef" }), bytes: () => new Uint8Array() };
      return { json: () => ({}), bytes: () => new Uint8Array([1, 2, 3]) };
    },
    fs: fsh.api,
    extract: async () => { /* pretend success */ },
    sha256: () => "deadbeef",
    ...rest,
  };
}

describe("NodePtyProvisioner.install", () => {
  it("aborts when checksums.json lacks the asset entry", async () => {
    const fsh = makeFs(NOT_INSTALLED);
    const deps = baseDeps({ fsh, fetch: async () => ({ json: () => ({}), bytes: () => new Uint8Array([1]) }) });
    const r = await new NodePtyProvisioner(deps).install();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/checksum/i);
    expect(fsh.removed).toEqual([]); // nothing extracted/cleared
  });

  it("aborts on checksum mismatch without extracting", async () => {
    const fsh = makeFs(NOT_INSTALLED);
    const deps = baseDeps({ fsh, sha256: () => "cafe" }); // != "deadbeef"
    const r = await new NodePtyProvisioner(deps).install();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mismatch/i);
  });

  it("happy path on unix: extracts and chmods spawn-helper", async () => {
    const fsh = makeFs(NOT_INSTALLED);
    const progress: string[] = [];
    const deps = baseDeps({ fsh });
    fsh.files.add("/plugin/node_modules/node-pty/prebuilds/linux-x64/spawn-helper");
    const r = await new NodePtyProvisioner(deps).install((m) => progress.push(m));
    expect(r.ok).toBe(true);
    expect(fsh.chmods).toContainEqual(["/plugin/node_modules/node-pty/prebuilds/linux-x64/spawn-helper", 0o755]);
    expect(progress.some((m) => /download/i.test(m))).toBe(true);
  });

  it("on win32 writes the patched windowsConoutConnection.js", async () => {
    const fsh = makeFs(NOT_INSTALLED);
    const deps = baseDeps({ fsh, platform: "win32", fetch: async (url: string) =>
      url.endsWith("checksums.json")
        ? { json: () => ({ "node-pty-win32-x64.zip": "deadbeef" }), bytes: () => new Uint8Array() }
        : { json: () => ({}), bytes: () => new Uint8Array([1]) } });
    const r = await new NodePtyProvisioner(deps).install();
    expect(r.ok).toBe(true);
    expect([...fsh.files]).toContain("/plugin/node_modules/node-pty/lib/windowsConoutConnection.js");
  });
});

describe("NodePtyProvisioner.status / remove", () => {
  it("reports ready when the listing satisfies isInstalled", async () => {
    const fsh = makeFs({ hasEntryJs: true, hasPrebuild: true, hasSpawnHelper: true, hasWinPatch: false });
    const s = await new NodePtyProvisioner(baseDeps({ fsh })).status();
    expect(s.state).toBe("ready");
  });
  it("remove() clears the binary dir", async () => {
    const fsh = makeFs(NOT_INSTALLED);
    fsh.api.mkdir("/plugin/node_modules/node-pty");
    await new NodePtyProvisioner(baseDeps({ fsh })).remove();
    expect(fsh.removed).toContain("/plugin/node_modules/node-pty");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ptyBinary.test.ts`
Expected: FAIL — `Cannot find module "../src/backends/ptyBinary"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/backends/ptyBinary.ts`:

```ts
import type { PtyProvisioner, PtyProvisionState } from "../core/ports";
import { assetNameFor, downloadUrls, verifyChecksum, isInstalled } from "../core/terminalBinary";

export interface ProvisionFetch {
  (url: string): Promise<{ json(): unknown; bytes(): Uint8Array }>;
}

export interface ProvisionFs {
  exists(p: string): boolean;
  mkdir(p: string): void;
  writeFile(p: string, data: Uint8Array | string): void;
  rm(p: string): void;
  chmod(p: string, mode: number): void;
  listing(nodePtyDir: string, platform: string, arch: string): import("../core/terminalBinary").BinaryListing;
}

export interface NodePtyProvisionerDeps {
  pluginDir: string;
  repo: string;
  version: string;
  platform: string;
  arch: string;
  patchText: string;
  join(...parts: string[]): string;
  fetch: ProvisionFetch;
  fs: ProvisionFs;
  extract(zipPath: string, destDir: string): Promise<void>;
  sha256(bytes: Uint8Array): string;
}

export class NodePtyProvisioner implements PtyProvisioner {
  private state: PtyProvisionState = "not-installed";
  private message = "";
  constructor(private d: NodePtyProvisionerDeps) {}

  binaryDir(): string {
    return this.d.join(this.d.pluginDir, "node_modules", "node-pty");
  }

  async status(): Promise<{ state: PtyProvisionState; message?: string }> {
    if (this.state === "downloading") return { state: this.state, message: this.message };
    const listing = this.d.fs.listing(this.binaryDir(), this.d.platform, this.d.arch);
    this.state = isInstalled(listing, this.d.platform) ? "ready" : "not-installed";
    return { state: this.state, message: this.message };
  }

  async install(onProgress?: (msg: string) => void): Promise<{ ok: boolean; message: string }> {
    const p = (m: string) => { this.message = m; onProgress?.(m); };
    try {
      this.state = "downloading";
      const asset = assetNameFor(this.d.platform, this.d.arch);
      const urls = downloadUrls(this.d.repo, this.d.version, asset);

      p("Downloading checksums…");
      const checksums = (await this.d.fetch(urls.checksums)).json() as Record<string, string>;
      const expected = checksums?.[asset];
      if (!expected) { this.state = "error"; return { ok: false, message: `No checksum found for ${asset}` }; }

      p(`Downloading ${asset}…`);
      const bytes = (await this.d.fetch(urls.asset)).bytes();
      if (!verifyChecksum(this.d.sha256(bytes), expected)) {
        this.state = "error";
        return { ok: false, message: `Checksum mismatch for ${asset}` };
      }

      p("Extracting…");
      const tmpDir = this.d.join(this.d.pluginDir, "tmp");
      this.d.fs.mkdir(tmpDir);
      const tmpZip = this.d.join(tmpDir, asset);
      this.d.fs.writeFile(tmpZip, bytes);

      const dir = this.binaryDir();
      if (this.d.fs.exists(dir)) this.d.fs.rm(dir);
      this.d.fs.mkdir(dir);
      await this.d.extract(tmpZip, dir);

      if (this.d.platform === "win32") {
        this.d.fs.writeFile(this.d.join(dir, "lib", "windowsConoutConnection.js"), this.d.patchText);
      } else {
        const helper = this.d.join(dir, "prebuilds", `${this.d.platform}-${this.d.arch}`, "spawn-helper");
        if (this.d.fs.exists(helper)) this.d.fs.chmod(helper, 0o755);
      }

      try { this.d.fs.rm(tmpZip); } catch { /* ignore */ }

      this.state = "ready";
      return { ok: true, message: "Terminal support installed" };
    } catch (e) {
      this.state = "error";
      return { ok: false, message: String(e) };
    }
  }

  async remove(): Promise<void> {
    const dir = this.binaryDir();
    if (this.d.fs.exists(dir)) this.d.fs.rm(dir);
    this.state = "not-installed";
    this.message = "";
  }
}
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `npx vitest run tests/ptyBinary.test.ts && npm run typecheck`
Expected: PASS (all `ptyBinary` tests green; typecheck clean).

- [ ] **Step 5: Commit**

```bash
git add src/backends/ptyBinary.ts tests/ptyBinary.test.ts
git commit -m "feat(terminal): NodePtyProvisioner adapter (download, verify, extract)"
```

---

### Task 3: Dependency swap + absolute-path loader

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `esbuild.config.mjs:8` (external entry)
- Modify: `src/backends/pty.ts` (loader)
- Test: `tests/pty.test.ts` (add one case)

**Interfaces:**
- Consumes: none new.
- Produces: `makeDefaultSpawn(pluginDir: string): PtySpawn` exported from `src/backends/pty.ts`; `NodePtyHost` constructor now requires an explicit `PtySpawn` (no default).

- [ ] **Step 1: Swap the dependency**

Run:
```bash
npm uninstall @homebridge/node-pty-prebuilt-multiarch
npm install node-pty@^1.1.0
```
Expected: `package.json` `dependencies` now lists `node-pty` and no longer lists `@homebridge/node-pty-prebuilt-multiarch`.

- [ ] **Step 2: Update the esbuild external**

In `esbuild.config.mjs:8`, change the external array entry from
`"@homebridge/node-pty-prebuilt-multiarch"` to `"node-pty"`:

```js
external: ["obsidian", "electron", "node-pty", ...builtins],
```

- [ ] **Step 3: Write the failing test**

Add to `tests/pty.test.ts` (new `describe` block at the end of the file):

```ts
import { makeDefaultSpawn } from "../src/backends/pty";

describe("makeDefaultSpawn", () => {
  it("requires node-pty from the plugin's node_modules by absolute path", () => {
    const calls: string[] = [];
    (globalThis as any).window = {
      require: (id: string) => {
        calls.push(id);
        if (id.includes("node_modules")) {
          return { spawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) };
        }
        if (id === "path") return { join: (...p: string[]) => p.join("/") };
        throw new Error(`unexpected require ${id}`);
      },
    };
    const spawn = makeDefaultSpawn("/vault/.obsidian/plugins/oawm");
    spawn("bash", [], { name: "xterm-color", cols: 80, rows: 24 } as any);
    expect(calls).toContain("/vault/.obsidian/plugins/oawm/node_modules/node-pty");
    delete (globalThis as any).window;
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/pty.test.ts`
Expected: FAIL — `makeDefaultSpawn` is not exported.

- [ ] **Step 5: Update `src/backends/pty.ts`**

Replace the `defaultSpawn` function (lines 18-23) and the `NodePtyHost` constructor (line 26) with:

```ts
/** Builds a spawn fn that loads node-pty from the plugin's own node_modules by
 *  absolute path (Obsidian's renderer require does not resolve plugin-relative),
 *  falling back to a bare require. Loaded lazily so a missing binary only fails
 *  at spawn time — TerminalView turns that into the in-pane install prompt. */
export function makeDefaultSpawn(pluginDir: string): PtySpawn {
  return (file, args, opts) => {
    const req = (window as unknown as { require: (id: string) => unknown }).require;
    const path = req("path") as { join: (...p: string[]) => string };
    let pty: { spawn: PtySpawn };
    try {
      pty = req(path.join(pluginDir, "node_modules", "node-pty")) as { spawn: PtySpawn };
    } catch {
      pty = req("node-pty") as { spawn: PtySpawn };
    }
    return pty.spawn(file, args, opts);
  };
}

export class NodePtyHost implements PtyBackend {
  constructor(private ptySpawn: PtySpawn) {}
```

(Delete the old `defaultSpawn` and the `= defaultSpawn` default. The `spawn(...)` method body below stays unchanged.)

- [ ] **Step 6: Run the full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS — all tests green (existing `pty.test.ts` cases still pass since they pass an explicit spawn), typecheck clean, `main.js` emitted.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json esbuild.config.mjs src/backends/pty.ts tests/pty.test.ts
git commit -m "feat(terminal): load mainline node-pty by absolute path; drop homebridge fork"
```

---

### Task 4: In-pane install prompt in `TerminalView`

**Files:**
- Modify: `src/obsidian/terminalView.ts`

**Interfaces:**
- Consumes (Task 1/2): `PtyProvisioner`.
- Produces: `TerminalView` constructor signature `constructor(leaf: WorkspaceLeaf, ptyBackend: PtyBackend, provisioner: PtyProvisioner)`.

**Note:** Per CLAUDE.md, `ItemView` DOM has **no node tests**. Verification for this task is `npm run typecheck` + `npm run build` + the manual checklist added in Task 8. Do not invent a DOM test harness.

- [ ] **Step 1: Add the provisioner arg + gate the render**

In `src/obsidian/terminalView.ts`:

1. Import the port at the top:
```ts
import type { PtyBackend, PtyHandle, PtyProvisioner } from "../core/ports";
```
2. Change the constructor (line 22) to take the provisioner:
```ts
constructor(leaf: WorkspaceLeaf, private ptyBackend: PtyBackend, private provisioner: PtyProvisioner) { super(leaf); }
```
3. Replace `start()` (lines 31-34) so it checks provisioning before rendering:
```ts
async start(state: TerminalViewState) {
  this.state = state;
  const { state: s } = await this.provisioner.status();
  if (s === "ready") this.render();
  else this.renderInstallPrompt();
}
```

- [ ] **Step 2: Add the install-prompt renderer**

Add this method to the class (e.g. after `render()`):

```ts
private renderInstallPrompt(message?: string) {
  this.pty?.kill();
  this.term?.dispose();
  this.pty = undefined; this.term = undefined; this.fit = undefined;
  const el = this.contentEl;
  el.empty();
  el.addClass("oawm-terminal-setup");
  el.createEl("p", { text: "The in-app terminal needs a one-time native component (node-pty)." });
  if (message) el.createEl("p", { text: message, cls: "oawm-terminal-setup-msg" });
  const btn = el.createEl("button", { text: "Download terminal support" });
  const source = el.createEl("p", { cls: "oawm-terminal-setup-src" });
  source.setText("Downloaded from this plugin's GitHub release and verified by checksum.");
  const hint = el.createEl("p", { cls: "oawm-terminal-setup-hint" });
  hint.setText("Or switch Terminal host to \"External window\" in settings.");

  btn.onclick = async () => {
    btn.disabled = true;
    const onProgress = (m: string) => btn.setText(m);
    const r = await this.provisioner.install(onProgress);
    if (r.ok) {
      new Notice("OAWM: terminal support installed.");
      this.render();
    } else {
      btn.disabled = false;
      btn.setText("Retry download");
      this.renderInstallPrompt(r.message);
      new Notice(`OAWM: terminal support failed: ${r.message}`);
    }
  };
}
```

- [ ] **Step 3: Route spawn failures to the prompt**

In `render()`, change the `catch (e)` block (lines 59-63) so a spawn failure shows the prompt (the binary may be corrupt/incompatible) instead of only writing to xterm:

```ts
} catch (e) {
  this.renderInstallPrompt(`Could not start the terminal: ${String(e)}`);
  return;
}
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS — typecheck clean, `main.js` emitted. (TerminalView's new third constructor arg will make `src/main.ts` fail typecheck only after Task 5 wires it; if you run typecheck before Task 5, expect the main.ts call site error — that is wired in Task 5. To keep this task independently green, do Step 5 next before committing.)

- [ ] **Step 5: Commit (with Task 5)**

This task's compile depends on the Task 5 wiring (constructor arity). Commit them together at the end of Task 5.

---

### Task 5: Wire the provisioner in `main.ts` + settings control

**Files:**
- Modify: `src/main.ts` (composition at lines 76-79; settings block near line 261)

**Interfaces:**
- Consumes: `NodePtyProvisioner` (Task 2), `makeDefaultSpawn` (Task 3), `TerminalView` 3-arg constructor (Task 4), `requestUrl` (obsidian), `node:fs`, `node:crypto`, `node:path`, `run` (`src/backends/exec.ts`).
- Produces: a single `this.provisioner` instance shared by `NodePtyHost` loader and `TerminalView`.

**Note:** DOM/composition — verify via typecheck/build + manual checklist (Task 8), no node test.

- [ ] **Step 1: Add imports**

At the top of `src/main.ts`, add:
```ts
import { requestUrl } from "obsidian";
import { existsSync, mkdirSync as fsMkdir, writeFileSync as fsWrite, rmSync, chmodSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { NodePtyProvisioner } from "./backends/ptyBinary";
import { makeDefaultSpawn } from "./backends/pty";
import { run } from "./backends/exec";
import { VERSION } from "./version";
```
(Adjust existing `node:fs` import on line 3 if it already imports some of these — merge, don't duplicate.)

- [ ] **Step 2: Build the provisioner and rewire the terminal**

Replace `main.ts:78-79`:
```ts
this.pty = new NodePtyHost();
this.registerView(TERMINAL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TerminalView(leaf, this.pty));
```
with:
```ts
const pluginDir = join(vaultRoot, this.manifest.dir ?? "");
this.provisioner = new NodePtyProvisioner({
  pluginDir,
  repo: "scottTomaszewski/obsidian-agent-workspace-manager",
  version: VERSION,
  platform: process.platform,
  arch: process.arch,
  patchText: "", // win32 patch wired in Task 6
  join: (...parts: string[]) => join(...parts),
  fetch: async (url: string) => {
    const resp = await requestUrl({ url });
    return { json: () => resp.json, bytes: () => new Uint8Array(resp.arrayBuffer) };
  },
  fs: {
    exists: (p) => existsSync(p),
    mkdir: (p) => fsMkdir(p, { recursive: true }),
    writeFile: (p, data) => fsWrite(p, data as NodeJS.ArrayBufferView | string),
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    chmod: (p, mode) => chmodSync(p, mode),
    listing: (dir, platform, arch) => {
      const prebuildDir = join(dir, "prebuilds", `${platform}-${arch}`);
      const buildRelease = join(dir, "build", "Release");
      const hasNode = (d: string) => { try { return readdirSync(d).some((f) => f.endsWith(".node")); } catch { return false; } };
      return {
        hasEntryJs: existsSync(join(dir, "lib", "index.js")),
        hasPrebuild: hasNode(prebuildDir) || hasNode(buildRelease),
        hasSpawnHelper: existsSync(join(prebuildDir, "spawn-helper")),
        hasWinPatch: existsSync(join(dir, "lib", "windowsConoutConnection.js")),
      };
    },
  },
  extract: async (zipPath, destDir) => {
    if (process.platform === "win32") {
      await run("powershell", ["-NoProfile", "-Command",
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]);
    } else {
      await run("unzip", ["-o", zipPath, "-d", destDir]);
    }
  },
  sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
});
this.pty = new NodePtyHost(makeDefaultSpawn(pluginDir));
this.registerView(TERMINAL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TerminalView(leaf, this.pty, this.provisioner));
```

- [ ] **Step 3: Declare the field**

Near `private pty!: NodePtyHost;` (line 55), add:
```ts
private provisioner!: NodePtyProvisioner;
```

- [ ] **Step 4: Add the settings control**

In the settings `display()` method, after the "Terminal host" `Setting` block (after `main.ts:270`, inside the same section), add:
```ts
new Setting(containerEl)
  .setName("Terminal support (native component)")
  .setDesc("Downloads node-pty for the embedded terminal from this plugin's GitHub release, verified by checksum. Required only for the embedded host.")
  .addButton((b) =>
    b.setButtonText("Download / re-download").onClick(async () => {
      b.setDisabled(true);
      const r = await this.plugin.provisioner.install((m) => b.setButtonText(m));
      new Notice(r.ok ? "OAWM: terminal support installed." : `OAWM: ${r.message}`);
      b.setDisabled(false);
      b.setButtonText("Download / re-download");
    }))
  .addExtraButton((b) =>
    b.setIcon("trash").setTooltip("Remove downloaded binary").onClick(async () => {
      await this.plugin.provisioner.remove();
      new Notice("OAWM: terminal support removed.");
    }));
```
(If `this.plugin.provisioner` is not accessible from the settings tab, expose it as a public field on the plugin class — it is created in `onload`.)

- [ ] **Step 5: Typecheck + build + full test**

Run: `npm run typecheck && npm run build && npm test`
Expected: PASS — typecheck clean (TerminalView arity now satisfied), `main.js` emitted, all tests green.

- [ ] **Step 6: Commit (Tasks 4 + 5 together)**

```bash
git add src/obsidian/terminalView.ts src/main.ts styles.css
git commit -m "feat(terminal): in-pane install prompt + settings control, wired to provisioner"
```
(Include `styles.css` only if you added `.oawm-terminal-setup*` styles; optional — defaults render fine.)

---

### Task 6: Windows ConPTY patch

**Files:**
- Create: `src/patches/windowsConoutConnection.js.txt` (vendored patch text)
- Create: `src/types/text-modules.d.ts` (typecheck shim for `*.txt` imports)
- Modify: `esbuild.config.mjs` (add `.txt` text loader)
- Modify: `tsconfig.json` (ensure the `.d.ts` is included — usually automatic)
- Modify: `src/main.ts` (import the patch text, pass as `patchText` on win32)

**Interfaces:**
- Consumes: `NodePtyProvisionerDeps.patchText` (Task 2).
- Produces: none (composition-only).

**Why:** node-pty's `lib/windowsConoutConnection.js` spawns a `Worker` thread, which Electron's renderer forbids. The patch replaces it with inline socket piping so ConPTY works inside Obsidian on Windows. Highest-risk task; requires a Windows machine to verify end-to-end.

- [ ] **Step 1: Vendor the patch**

Obtain the patched file content and save it to `src/patches/windowsConoutConnection.js.txt`. Source it from the upstream reference implementation (e.g. the `patches/windowsConoutConnection.js` used by `sdkasper/lean-obsidian-terminal`, MIT) or derive it from node-pty's own `windowsConoutConnection.js` by replacing the `new Worker(...)` conout reader with a direct `net.Socket` pipe. **Check and preserve the source license header.** Verify the file: it must export the same surface node-pty's `lib/index.js` consumes (the `ConoutConnection` class with `connect()`, `dispose()`, and the `'ready'` event) and must not reference `worker_threads`.

Run after saving: `grep -c "worker_threads" src/patches/windowsConoutConnection.js.txt`
Expected: `0`.

- [ ] **Step 2: Add the typecheck shim**

Create `src/types/text-modules.d.ts`:
```ts
declare module "*.txt" {
  const content: string;
  export default content;
}
```

- [ ] **Step 3: Add the esbuild text loader**

In `esbuild.config.mjs`, add a `loader` map to the `esbuild.context({...})` options:
```js
loader: { ".txt": "text" },
```

- [ ] **Step 4: Pass the patch text on win32**

In `src/main.ts`, add the import near the other imports:
```ts
import WINDOWS_CONOUT_PATCH from "./patches/windowsConoutConnection.js.txt";
```
and change the provisioner's `patchText` field (set to `""` in Task 5) to:
```ts
patchText: process.platform === "win32" ? WINDOWS_CONOUT_PATCH : "",
```

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS — typecheck clean, `main.js` emitted (the patch text is inlined into the bundle).

- [ ] **Step 6: Commit**

```bash
git add src/patches/windowsConoutConnection.js.txt src/types/text-modules.d.ts esbuild.config.mjs src/main.ts
git commit -m "feat(terminal): vendor Windows ConPTY patch, inline + apply on win32 install"
```

---

### Task 7: CI release pipeline + justfile cleanup

**Files:**
- Create: `.github/workflows/release-binaries.yml`
- Modify: `justfile` (remove the `dist-plugin`/zip assembly)

**Interfaces:** none (build/release infra).

**Why:** Publish per-platform `node-pty` zips + `checksums.json` to each GitHub Release so the runtime download has assets to fetch. `just release` keeps creating the release with the loose `main.js`/`manifest.json`/`styles.css`; this workflow attaches the binaries to that release after it's published.

- [ ] **Step 1: Add the workflow**

Create `.github/workflows/release-binaries.yml`:
```yaml
name: Release node-pty binaries
on:
  release:
    types: [published]

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            asset: node-pty-linux-x64.zip
          - os: macos-13
            asset: node-pty-darwin-x64.zip
          - os: macos-14
            asset: node-pty-darwin-arm64.zip
          - os: windows-latest
            asset: node-pty-win32-x64.zip
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Install node-pty (materialises the platform prebuild)
        run: npm install node-pty@^1.1.0 --no-save
      - name: Verify the prebuild exists
        shell: bash
        run: |
          test -f node_modules/node-pty/lib/index.js
          ls node_modules/node-pty/prebuilds/*/ | grep -E '\.node$'
      - name: Package the runtime subset (bash)
        if: runner.os != 'Windows'
        shell: bash
        run: |
          cd node_modules/node-pty
          zip -r "../../${{ matrix.asset }}" package.json lib prebuilds build 2>/dev/null || \
          zip -r "../../${{ matrix.asset }}" package.json lib prebuilds
          cd ../..
          shasum -a 256 "${{ matrix.asset }}" | awk '{print $1}' > "${{ matrix.asset }}.sha256"
      - name: Package the runtime subset (windows)
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          $items = @("package.json","lib","prebuilds")
          if (Test-Path node_modules/node-pty/build) { $items += "build" }
          Compress-Archive -Path ($items | ForEach-Object { "node_modules/node-pty/$_" }) -DestinationPath "${{ matrix.asset }}" -Force
          (Get-FileHash "${{ matrix.asset }}" -Algorithm SHA256).Hash.ToLower() | Out-File -NoNewline "${{ matrix.asset }}.sha256"
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.asset }}
          path: |
            ${{ matrix.asset }}
            ${{ matrix.asset }}.sha256

  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: dist
      - name: Build checksums.json
        shell: bash
        run: |
          cd dist
          echo "{" > checksums.json
          first=true
          for d in node-pty-*.zip; do
            asset="$d"
            hash="$(cat "$d.sha256/$d.sha256" 2>/dev/null || cat "$asset/$asset.sha256")"
            if [ "$first" = true ]; then first=false; else echo "," >> checksums.json; fi
            printf '  "%s": "%s"' "$asset" "$hash" >> checksums.json
          done
          echo "" >> checksums.json
          echo "}" >> checksums.json
          cat checksums.json
      - name: Upload assets to the release
        env:
          GH_TOKEN: ${{ github.token }}
        shell: bash
        run: |
          cd dist
          gh release upload "${{ github.event.release.tag_name }}" \
            node-pty-*.zip/*.zip checksums.json --clobber
```

**Note for the implementer:** artifact download nests each file under a directory named after the artifact. Before merging, do a dry run on a test tag and adjust the `gh release upload` glob / `checksums.json` hash paths to match the actual `dist/` layout (the exact nesting depends on the `upload-artifact` version). The end state must be: one `checksums.json` plus the four `node-pty-<platform>-<arch>.zip` files attached to the release, with `checksums.json` keys exactly matching the asset filenames.

- [ ] **Step 2: Remove the obsolete zip assembly from `justfile`**

In `justfile`, delete the block that builds `dist-plugin/` and `oawm-<version>.zip` (the section commented "Assemble a self-contained plugin folder including the native terminal module…", through the `zip -r` line), and remove `oawm-"$version".zip` from the `gh release create` asset list. The release should attach only `main.js manifest.json styles.css`. The CI workflow above adds the binaries afterward.

- [ ] **Step 3: Sanity-check the justfile**

Run: `just --summary | tr ' ' '\n' | grep -x release`
Expected: `release` still listed (recipe intact, just slimmer).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-binaries.yml justfile
git commit -m "ci(terminal): publish per-platform node-pty binaries + checksums on release"
```

---

### Task 8: Docs sync

**Files:**
- Modify: `ARCHITECTURE.md` (module map)
- Modify: `docs/gotchas.md` (rewrite the native-module section)
- Modify: `CHANGELOG.md` (Unreleased bullet)
- Modify: `FOLLOWUPS.md` (three numbered items)
- Modify: `docs/MANUAL-TEST.md` (terminal-support checks)

**Interfaces:** none.

- [ ] **Step 1: ARCHITECTURE.md** — In the module map, add: `src/core/terminalBinary.ts` (pure provisioning helpers), `src/backends/ptyBinary.ts` (`NodePtyProvisioner`), the `PtyProvisioner` port, and a one-line install flow: `TerminalView.status() → not-installed → in-pane prompt → install (fetch+verify+extract) → spawn`.

- [ ] **Step 2: docs/gotchas.md** — Replace the "Embedded terminal: native module packaging & ABI" section (lines 145-151). New content:
  - node-pty is `external` and loaded by **absolute path** from `<pluginDir>/node_modules/node-pty` (Obsidian's renderer `require` does not resolve plugin-relative).
  - It is **downloaded at runtime** from this repo's GitHub Release (pinned to the plugin `VERSION`), SHA-256-verified against `checksums.json` (verification mandatory). Loose store/BRAT installs work because nothing native ships in the bundle.
  - We use **mainline `node-pty` (N-API)** → prebuilds are **ABI-stable across Electron versions**; the old per-`process.versions.modules` revalidation step is **gone**.
  - Windows ships a patched `windowsConoutConnection.js` (no renderer Worker threads); the patch text is inlined into `main.js` and written on win32 install.
  - Keep the xterm CSS note (line 152-153) and the zellij-spine note (line 154-155).

- [ ] **Step 3: CHANGELOG.md** — under `## Unreleased`, add:
  `- Embedded terminal now downloads its native component (node-pty) on demand, so it works with community-store and BRAT installs; switched to ABI-stable mainline node-pty (no more per-Electron-bump revalidation).`

- [ ] **Step 4: FOLLOWUPS.md** — add three numbered items (take N from `next-id`, bump it): (a) bake `checksums.json` into `main.js` at build time (requires building `main.js` in CI after binaries exist); (b) skip rebuilding binaries on releases where the pinned node-pty version is unchanged, re-pointing the download to the last binary release; (c) prune the stale `node_modules/@homebridge` directory left in pre-existing installs after upgrade.

- [ ] **Step 5: docs/MANUAL-TEST.md** — add checks: (1) fresh install (no binary) → opening a task terminal shows the "Download terminal support" prompt; (2) clicking it shows progress then starts the terminal; (3) Settings → "Terminal support" mirrors status and re-download/remove work; (4) offline / bad network → prompt shows an error + the external-window hint, and switching `Terminal host` to External still launches; (5) after `remove()`, the prompt returns.

- [ ] **Step 6: Commit**

```bash
git add ARCHITECTURE.md docs/gotchas.md CHANGELOG.md FOLLOWUPS.md docs/MANUAL-TEST.md
git commit -m "docs(terminal): runtime binary provisioning across architecture/gotchas/changelog"
```

---

## Self-Review

**Spec coverage:** runtime download (T2/T5) ✓; mainline node-pty N-API swap (T3) ✓; in-pane one-click prompt (T4) ✓; absolute-path load (T3) ✓; cross-platform binaries + checksums CI (T7) ✓; mandatory checksum verify (T1/T2) ✓; version-tag pinning (T1/T5) ✓; embedded stays default + external fallback (T4/existing) ✓; Windows ConPTY patch (T6) ✓; settings control (T5) ✓; docs/gotchas/ABI-note removal (T8) ✓; deferred hardening + rebuild-skip + @homebridge cleanup → FOLLOWUPS (T8) ✓; out-of-scope items not built ✓.

**Placeholder scan:** `patchText: ""` in Task 5 is an intentional, real value superseded in Task 6 (noted at both sites). The Windows patch (T6 Step 1) and the CI artifact-path nesting (T7) carry explicit "verify against actual output" instructions rather than blind code, because both depend on environment specifics the plan cannot fabricate — each states the exact end-state to confirm. No `TBD`/`TODO`/"handle edge cases".

**Type consistency:** `PtyProvisioner` (status/install/remove/binaryDir) is identical across T1 (port), T2 (impl), T4/T5 (consumers). `BinaryListing` fields (`hasEntryJs/hasPrebuild/hasSpawnHelper/hasWinPatch`) match across T1, T2, and the T5 `listing` adapter. `NodePtyProvisionerDeps` shape matches the T5 construction site. `makeDefaultSpawn(pluginDir)` defined in T3, used in T5.
