/**
 * Canonical slash / thread-reply authorization against `SLASH_ALLOWED_ASSOCIATIONS`.
 * Shared by webhook intake and the thread-reply classify worker.
 */
export function isSlashAssociationAllowed(
  allowed: ReadonlySet<string>,
  association: string | null | undefined,
): boolean {
  if (allowed.has("*")) return true;
  if (association && allowed.has(association.toUpperCase())) return true;
  return false;
}
