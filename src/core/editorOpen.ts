export function buildEditorCommand(template: string, ctx: { file: string; line?: number }): string {
  return template
    .replace(/\{file\}/g, ctx.file)
    .replace(/\{line\}/g, String(ctx.line ?? 1));
}
