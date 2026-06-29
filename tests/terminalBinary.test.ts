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
