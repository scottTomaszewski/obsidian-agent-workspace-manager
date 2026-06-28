function shellQuote(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

export function buildEditorCommand(template: string, ctx: { file: string; line?: number }): string {
  return template
    .replace(/\{file\}/g, shellQuote(ctx.file))
    .replace(/\{line\}/g, String(ctx.line ?? 1));
}
