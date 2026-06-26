import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/backends/exec";
import { HOOK_SCRIPT } from "../src/hookScript";

describe("oawm-hook (embedded HOOK_SCRIPT)", () => {
  it("writes a marker file for the task when run", async () => {
    const work = mkdtempSync(join(tmpdir(), "oawm-hook-"));
    const hookFile = join(work, "oawm-hook.mjs");
    writeFileSync(hookFile, HOOK_SCRIPT);
    const statusDir = join(work, "status");

    const res = await run("node", [hookFile, "review", "--task", "DS-1", "--status-dir", statusDir]);
    expect(res.code).toBe(0);

    const marker = join(statusDir, "DS-1.json");
    expect(existsSync(marker)).toBe(true);
    const data = JSON.parse(readFileSync(marker, "utf8"));
    expect(data.event).toBe("review");
    expect(typeof data.ts).toBe("number");
  });

  it("exits non-zero when required args are missing", async () => {
    const work = mkdtempSync(join(tmpdir(), "oawm-hook-"));
    const hookFile = join(work, "oawm-hook.mjs");
    writeFileSync(hookFile, HOOK_SCRIPT);
    const res = await run("node", [hookFile, "review"]); // no --task / --status-dir
    expect(res.code).toBe(2);
  });
});
