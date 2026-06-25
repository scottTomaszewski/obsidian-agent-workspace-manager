import { describe, it, expect } from "vitest";
import { VERSION } from "../src/version";

describe("scaffold", () => {
  it("exposes a version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
