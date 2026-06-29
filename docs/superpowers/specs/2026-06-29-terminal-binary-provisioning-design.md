# Terminal Native-Binary Provisioning — Design

**Date:** 2026-06-29
**Status:** Approved design, ready for implementation planning
**Scope:** Make the embedded terminal's native dependency (`node-pty`) work for **every**
install path — community store, BRAT, and manual — by downloading the platform binary at
runtime instead of relying on it sitting next to `main.js`. Includes swapping the
`@homebridge/node-pty-prebuilt-multiarch` fork for mainline **`node-pty` (N-API)**, a
GitHub Actions matrix that builds/publishes per-platform binaries with checksums, an
in-pane one-click install prompt, and retirement of the self-contained-zip release
machinery. Builds directly on `2026-06-28-embedded-terminal-design.md`.

## Summary

The embedded terminal (`TerminalView` + `NodePtyHost`) needs a real PTY via a native
module. Today that module is marked `external` in esbuild and `require`d at runtime, so it
must physically sit in the plugin's `node_modules`. Only the release **zip** carries it;
the loose `main.js`/`manifest.json`/`styles.css` assets cannot. **BRAT and the community
store install only the loose assets**, so for those users `require(...)` throws
`Cannot find module '@homebridge/node-pty-prebuilt-multiarch'` and the terminal never
starts. This is the bug the user hit.

The fix follows the proven pattern from
[sdkasper/lean-obsidian-terminal](https://github.com/sdkasper/lean-obsidian-terminal):
ship **JS only**, and provision the native binary at runtime from our own GitHub Releases,
verified by SHA-256 and loaded by **absolute path**. This makes all install paths behave
identically and removes the "node_modules must be adjacent to main.js" fragility.

Switching to mainline `node-pty@^1.1.0` (which uses `node-addon-api`/**N-API**, ABI-stable
across Electron versions) additionally **deletes the per-Electron-ABI revalidation chore**
documented in `docs/gotchas.md` — a single prebuilt per `platform-arch` works regardless
of Obsidian's Electron ABI.

## Decisions (locked)

1. **Runtime download**, not bundling. Loose JS assets stay the store/BRAT install; the
   native binary is fetched on demand. (Alternatives — base64-embed all platforms in
   `main.js`, or keep shipping the zip — rejected: bloat / BRAT can't carry it.)
2. **Mainline `node-pty@^1.1.0`** replaces `@homebridge/node-pty-prebuilt-multiarch`.
   N-API ⇒ ABI-stable ⇒ no per-Electron-bump revalidation.
3. **User-initiated** download via a **one-click prompt rendered in the terminal pane**
   (size + source shown). Silent auto-download is rejected (community-store risk, metered
   networks). A mirror control also lives in Settings → Terminal support.
4. **Absolute-path load**: `window.require(join(pluginDir, "node_modules", "node-pty"))`
   with a bare-`require("node-pty")` fallback.
5. **Cross-platform, store-ready**: linux-x64, darwin-x64, darwin-arm64, win32-x64
   (win32-arm64 and linux-arm64 best-effort if the matrix yields them). Windows ships the
   patched `windowsConoutConnection.js` (ConPTY without renderer Worker threads).
6. **Mandatory checksum**: download aborts if `checksums.json` is missing or the asset's
   SHA-256 does not match.
7. **Binaries are pinned to the plugin's own release tag** (`src/version.ts` `VERSION`):
   the provisioner fetches from `releases/download/<VERSION>/…`, so a binary set always
   matches the JS that requests it.
8. **`terminalHost` stays `"embedded"` by default** (`main.ts:37`); "External window"
   remains the always-available, no-binary fallback.

## Why these choices

- **Every install path works the same.** The current per-vault breakage (the user's BRAT
  install) disappears; we stop maintaining a separate zip artifact whose only job is to
  smuggle `node_modules` past BRAT.
- **N-API ends a recurring maintenance tax.** `docs/gotchas.md` currently says to
  re-validate the prebuilt against `process.versions.modules` and re-release after every
  Electron bump. With N-API that step is gone.
- **Absolute-path require is robust.** A bare `require("@homebridge/…")` only resolves
  today because the zip happens to drop `node_modules` beside `main.js`. Requiring an
  absolute path makes loading independent of how the plugin was installed.
- **In-pane prompt is both discoverable and store-safe.** The user sees exactly why and
  what they're downloading, at the moment they need it, with a one-click action — no
  hunting in settings, no silent network fetch.

## Architecture & Components

Layering per `CLAUDE.md`: **pure decisions in `core` (unit-tested), side effects in
`backends`, thin DOM in `obsidian`, wired in `main.ts`.**

### New port — `PtyProvisioner` (`src/core/ports.ts`)

```ts
export type PtyProvisionState =
  | "ready" | "not-installed" | "downloading" | "error";

export interface PtyProvisioner {
  status(): Promise<{ state: PtyProvisionState; message?: string }>;
  install(onProgress?: (msg: string) => void): Promise<{ ok: boolean; message: string }>;
  remove(): Promise<void>;
  binaryDir(): string; // absolute path to <pluginDir>/node_modules/node-pty
}
```

Result-object returns, never throws to the UI (matches the `GitBackend` convention).

### New pure module — `src/core/terminalBinary.ts` (no I/O, fully unit-tested)

- `assetNameFor(platform, arch): string` → `node-pty-<platform>-<arch>.zip`.
- `isInstalled(listing: BinaryListing): boolean` → decides ready/not-installed from an
  injected description of what's on disk (entry JS present + a `pty.node` under
  `prebuilds/<platform>-<arch>/` or `build/Release/`, plus `spawn-helper` on unix /
  `windowsConoutConnection.js` patch on win32). Mirrors lean-terminal's `checkInstalled`,
  but as a pure function over a listing struct.
- `verifyChecksum(bytes: Uint8Array, expectedHex: string): boolean` → SHA-256 compare
  (hash computed by an injected hasher so the core stays I/O-free; the adapter passes
  Node `crypto`).
- `downloadUrls(repo, version, asset): { checksums: string; asset: string }` → builds the
  pinned `releases/download/<version>/…` URLs.

### New adapter — `src/backends/ptyBinary.ts` — `NodePtyProvisioner implements PtyProvisioner`

Constructor takes injected dependencies so the orchestration is testable without real
network/fs/exec:

```ts
new NodePtyProvisioner({
  pluginDir, repo: "scottTomaszewski/obsidian-agent-workspace-manager", version: VERSION,
  fetch,        // (url) => Promise<{ json(): any; bytes(): Uint8Array }>  (wraps requestUrl)
  fs,           // minimal { exists, mkdir, writeFile, readDir, rm, chmod }  (wraps node:fs)
  extract,      // (zipPath, destDir) => Promise<void>  (wraps run() → unzip/Expand-Archive)
  sha256,       // (bytes) => hex  (wraps node:crypto)
});
```

`install()` flow: `status()` short-circuits if ready → fetch `checksums.json` (**abort if
absent**) → fetch `node-pty-<platform>-<arch>.zip` → `verifyChecksum` (**abort on
mismatch**) → write zip to `<pluginDir>/tmp/` → clear & recreate
`<pluginDir>/node_modules/node-pty` → `extract` → `chmod +x` the unix `spawn-helper` →
on win32 write the bundled `windowsConoutConnection.js` patch → write a small
`.binary-manifest.json` (informational). Emits `onProgress` strings for the pane to show.

The Windows patch text is inlined into the bundle at build time (esbuild text loader,
as lean-terminal does) so no extra release asset is needed.

### Loader change — `src/backends/pty.ts`

`NodePtyHost` gains a `pluginDir` (and may hold a `PtyProvisioner` only for `binaryDir()`).
`defaultSpawn` becomes:

```ts
const nodePty = window.require(join(pluginDir, "node_modules", "node-pty"));
// fallback: window.require("node-pty")
return nodePty.spawn(file, args, opts);
```

The `PtySpawn` injection seam from the embedded-terminal design is preserved for tests.

### View change — `src/obsidian/terminalView.ts`

Before spawning, consult `provisioner.status()`. If not `ready`, render the **in-pane
CTA** instead of opening xterm:

```
In-app terminal needs a one-time native component.
[ Download support ~N MB ]   from github.com/scottTomaszewski/…/releases
Or use an external window (Settings → Terminal host)
```

The button calls `provisioner.install(onProgress)`, streaming progress into the pane; on
`ok` it re-renders and spawns; on failure it shows the message and keeps the external-host
hint (replacing the raw `String(e)` path at `terminalView.ts:60-61`). If a spawn still
throws after a "ready" status (e.g. corrupt binary), fall through to the same CTA with the
error. `TerminalView` gains a `PtyProvisioner` constructor arg.

### Composition — `src/main.ts`

Compute `pluginDir = join(vaultRoot, this.manifest.dir ?? "")` (already derived for
`oawm-hook.mjs` at `main.ts:69`). Construct one `NodePtyProvisioner`, pass it to both
`NodePtyHost` (`main.ts:78`) and the `TerminalView` factory (`main.ts:79`). Uses
`writeFileSync`/`node:fs` exactly as the hook helper already does.

### Settings — `src/obsidian/` settings block

Add a "Terminal support" row near the existing `terminalHost` control (`main.ts:260`):
status text (`Ready (vX) / Not installed / Error: …`) + **Download / Re-download / Remove**
buttons delegating to the same provisioner. Transparency for store review.

### Dependency swap

`package.json`: drop `@homebridge/node-pty-prebuilt-multiarch`, add `node-pty@^1.1.0`.
Keep it `external` in `esbuild.config.mjs:8` (rename the external entry). Re-copy xterm CSS
is unaffected.

## Data flow (install)

```
TerminalView.render()
  └─ provisioner.status()
       ├─ ready ──────────────► NodePtyHost.spawn() → xterm  (unchanged happy path)
       └─ not-installed ──────► render CTA
            └─ [Download] ─► provisioner.install(onProgress)
                 fetch checksums.json (abort if missing)
                 fetch node-pty-<plat>-<arch>.zip
                 verifyChecksum (abort on mismatch)
                 extract → <pluginDir>/node_modules/node-pty
                 chmod spawn-helper / write win patch
               └─ ok ─► re-render → spawn → xterm
```

## Release / CI pipeline (the novel part)

`just release` no longer assembles `dist-plugin/` or an `oawm-*.zip`. Instead a **GitHub
Actions matrix** produces the binaries:

- **Matrix runners:** `ubuntu-latest` (linux-x64), `macos-13` (darwin-x64), `macos-14`
  (darwin-arm64), `windows-latest` (win32-x64). Optional/best-effort arm Linux & Windows
  if a runner is available.
- **Per runner:** `npm ci` with `node-pty` pinned → this materialises
  `node_modules/node-pty/prebuilds/<platform>-<arch>/` (N-API prebuild) for that OS → prune
  to the runtime-needed subset (`package.json`, `lib/`, the one `prebuilds/<plat>-<arch>/`,
  unix `spawn-helper`) → `zip` to `node-pty-<platform>-<arch>.zip` → `sha256sum`.
- **Aggregate job:** merge the per-runner hashes into one `checksums.json`
  (`{ "<asset>.zip": "<sha256hex>", … }`) and attach all zips + `checksums.json` to the
  GitHub Release for the tag, alongside the standard loose `main.js`/`manifest.json`/
  `styles.css`.
- The plugin downloads from its **own version tag**, so the binaries are always the set
  built for that exact JS. (Optimization deferred: skip rebuilding binaries when the
  pinned `node-pty` version is unchanged and re-point to the last binary release — see
  FOLLOWUPS.)

## Security model

- **Transport:** `requestUrl` over HTTPS to `github.com` release assets (TLS-trusted).
- **Integrity:** `checksums.json` fetched from the same pinned tag; **mandatory** SHA-256
  verification of the downloaded zip before extraction; abort on missing entry or mismatch.
- **Provenance:** assets come only from this repo's Releases, produced by the CI matrix.
- **Hardening (follow-up, not v1):** bake the `checksums.json` contents into `main.js` at
  build time so verification trusts only the signed bundle, not a fetched checksums file.
  Deferred because it requires moving the `main.js` build into CI after the binaries exist;
  noted in FOLLOWUPS.

## Error handling

- Network failure / offline → `install()` returns `{ ok:false, message }`; pane shows the
  message + the "use external window" hint. Terminal host can be switched without a binary.
- Missing / mismatched checksum → hard abort, surfaced as an error message; nothing is
  extracted.
- Corrupt/incompatible binary at spawn → caught in `TerminalView`, re-shows the CTA with
  the error and a Re-download affordance.
- All adapter methods return result objects; user-facing strings go through the pane and
  `Notifier`, never thrown to the UI (per `CLAUDE.md`).

## Testing (TDD)

Write failing tests first for `core` and the adapter orchestration:

- `tests/terminalBinary.test.ts` (pure): `assetNameFor` across platform/arch matrix;
  `isInstalled` for present/absent/partial listings; `verifyChecksum` match & mismatch;
  `downloadUrls` pinning to `VERSION`.
- `tests/ptyBinary.test.ts` (adapter, injected fakes for fetch/fs/extract/sha256):
  aborts on missing `checksums.json`; aborts on checksum mismatch (nothing extracted);
  happy path lays out the expected files, chmods `spawn-helper`, writes the win patch on
  win32, emits progress; `status()` transitions; `remove()` clears the dir.
- `NodePtyHost` keeps its `PtySpawn` stub; add a test that the loader requires the
  absolute `binaryDir()` path.
- `TerminalView` DOM has **no node tests** (per convention) → add manual checks to
  `docs/MANUAL-TEST.md`: first-run CTA appears, download progresses, terminal starts after
  install, offline shows external-host hint, Settings status mirrors state.

Gate for done (`CLAUDE.md`): `npm run typecheck` clean + `npm test` green + `npm run build`
emits `main.js`.

## Docs & follow-ups (sync agreement)

- **ARCHITECTURE.md** — add `core/terminalBinary.ts`, `backends/ptyBinary.ts`, the
  `PtyProvisioner` port, and the install flow to the module map.
- **docs/gotchas.md** — rewrite the "native module packaging & ABI" section: the ABI
  revalidation note is **removed** (N-API); document runtime-download + absolute-path
  require + mandatory checksums + the version-pinned tag.
- **CHANGELOG.md** — Unreleased bullet: "Embedded terminal now downloads its native
  component on demand (works with BRAT / store installs); switched to ABI-stable node-pty."
- **FOLLOWUPS.md** — (a) bake checksums into the bundle; (b) skip binary rebuild when
  node-pty version unchanged; (c) clean up dead `node_modules/@homebridge` left in pre-
  existing installs after upgrade.
- **justfile** — remove the `dist-plugin`/zip assembly; release attaches loose assets and
  lets CI attach binaries + `checksums.json`.

## Migration

Existing installs that have `node_modules/@homebridge` (incl. the user's manually patched
`oawm-vault`) are unaffected functionally — the new loader looks for `node_modules/node-pty`,
finds it absent, and shows the CTA → one download fixes it. The stale `@homebridge`
directory is harmless; FOLLOWUP (c) optionally prunes it. The temporary per-vault copy made
while diagnosing the original bug is superseded by this flow.

## Out of scope (YAGNI)

- Session persistence / scrollback restore, shell-integration OSC, themes, tab colors
  (lean-terminal extras): **zellij remains the persistence spine**; the viewport doesn't
  need them.
- tmux `MuxBackend` (already deferred by the embedded-terminal spec).
- Bundling-in / offline-first binary delivery beyond the external-window fallback.
- linux-arm64 / win32-arm64 are best-effort, not gating.
