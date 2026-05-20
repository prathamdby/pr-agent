/**
 * First meaningful line must start with `/command` (plan: case-sensitive token).
 */
export function parseSlashCommand(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  const m = first.match(/^\/([a-z0-9-]+)(?:\s|$)/);
  return m?.[1] ?? null;
}
