import { REVIEW_TRUSTED_AUTHOR_ASSOCIATIONS } from "../settings/index.js";

export type ReviewAuthorTrust = "trusted" | "awaiting_approval";

export function reviewAuthorTrust(pr: {
  readonly author_association?: string | null;
  readonly head: { readonly repo?: { readonly id?: number | null } | null };
  readonly base?: { readonly repo?: { readonly id?: number | null } | null };
}): ReviewAuthorTrust {
  if (!pr.author_association || pr.head.repo == null) return "awaiting_approval";
  const headId = pr.head.repo.id;
  const baseId = pr.base?.repo?.id;
  return (headId != null && baseId != null && headId === baseId) ||
    REVIEW_TRUSTED_AUTHOR_ASSOCIATIONS.has(pr.author_association.toUpperCase())
    ? "trusted"
    : "awaiting_approval";
}

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
