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
