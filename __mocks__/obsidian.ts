// Minimal stub for the obsidian package used in tests.
// The real obsidian package is types-only (main: ""), so Vite/Vitest cannot
// bundle it. This stub provides the runtime values needed by vaultGateway.ts.

export class TFile {
  path: string = "";
  basename: string = "";
}

export class App {}
