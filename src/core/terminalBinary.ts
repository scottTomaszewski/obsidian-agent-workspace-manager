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
