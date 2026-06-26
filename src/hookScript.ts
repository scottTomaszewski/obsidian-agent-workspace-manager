/**
 * Source of the `oawm-hook` helper that Claude Code hooks invoke. It is embedded
 * here (rather than shipped as a separate plugin file) so the plugin can write
 * it to disk on load — guaranteeing it is present and version-matched without a
 * separate install step. It writes a status marker `<status-dir>/<task>.json`.
 */
export const HOOK_SCRIPT = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(\`--\${name}\`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const event = process.argv[2];
const task = arg("task");
const statusDir = arg("status-dir");

if (!event || !task || !statusDir) {
  console.error("usage: oawm-hook <event> --task <id> --status-dir <dir>");
  process.exit(2);
}

mkdirSync(statusDir, { recursive: true });
writeFileSync(join(statusDir, \`\${task}.json\`), JSON.stringify({ event, ts: Date.now() }));
process.exit(0);
`;
