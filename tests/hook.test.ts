import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/backends/exec";

describe("oawm-hook", () => {
  it("writes a marker file for the task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oawm-hook-"));
    const res = await run("node", ["bin/oawm-hook.mjs", "review", "--task", "DS-1", "--status-dir", dir], { cwd: process.cwd() });
    expect(res.code).toBe(0);
    const marker = join(dir, "DS-1.json");
    expect(existsSync(marker)).toBe(true);
    const data = JSON.parse(readFileSync(marker, "utf8"));
    expect(data.event).toBe("review");
    expect(typeof data.ts).toBe("number");
  });
});
