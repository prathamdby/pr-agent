import {
  REVIEW_TRUSTED_AUTHOR_ASSOCIATIONS,
  REVIEW_WORKFLOW_START_UNGATED_ASSOCIATIONS,
} from "../settings/index.ts";

export type ReviewAuthorTrust = "trusted" | "awaiting_maintainer_approval" | "awaiting_approval";

export function reviewAuthorTrust(pr: {
  readonly author_association?: string | null;
  readonly head: { readonly repo?: { readonly id?: number | null } | null };
  readonly base?: { readonly repo?: { readonly id?: number | null } | null };
}) {
  if (!pr.author_association || pr.head.repo == null)
    return ((pinnedReturn: ReviewAuthorTrust) => pinnedReturn)("awaiting_approval");
  const headId = pr.head.repo.id;
  const baseId = pr.base?.repo?.id;
  if (headId != null && baseId != null && headId === baseId)
    return ((pinnedReturn: ReviewAuthorTrust) => pinnedReturn)("trusted");
  const association = pr.author_association.toUpperCase();
  if (REVIEW_TRUSTED_AUTHOR_ASSOCIATIONS.has(association))
    return ((pinnedReturn: ReviewAuthorTrust) => pinnedReturn)("trusted");
  if (REVIEW_WORKFLOW_START_UNGATED_ASSOCIATIONS.has(association)) {
    return ((pinnedReturn: ReviewAuthorTrust) => pinnedReturn)("awaiting_maintainer_approval");
  }
  return ((pinnedReturn: ReviewAuthorTrust) => pinnedReturn)("awaiting_approval");
}

export function isSlashAssociationAllowed(
  allowed: ReadonlySet<string>,
  association: string | null | undefined,
) {
  if (allowed.has("*")) return ((pinnedReturn: boolean) => pinnedReturn)(true);
  if (association && allowed.has(association.toUpperCase()))
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  return ((pinnedReturn: boolean) => pinnedReturn)(false);
}
