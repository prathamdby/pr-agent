export const GITHUB_AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE",
  "MANNEQUIN",
] as const;

export const DEFAULT_MAINTAINER_DECISION_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/**
 * A dismissal decision needs both a known commenter and verified association
 * metadata. Reply text, display names, and the ability to reply are not authz.
 */
export function isAuthorizedMaintainerDecision(params: {
  readonly userId: number | null | undefined;
  readonly botUserId: number;
  readonly authorAssociation: string | null | undefined;
  readonly allowedAssociations: ReadonlySet<string>;
}): boolean {
  if (params.userId == null || params.userId === params.botUserId) return false;
  const association = params.authorAssociation?.trim().toUpperCase();
  if (!association || association === "*") return false;
  return params.allowedAssociations.has(association);
}
