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
