import type { CachedPrDiffIndex } from "../../prWorkspace/reviewDiffIndex.ts";
import { REVIEW_GATE_PROSE_UNASSESSED } from "../../settings/index.ts";
import { buildReviewPathProfile } from "../placement/reviewPathProfile.ts";
import type { ReviewPayload } from "../reviewSchema.ts";

const DEPENDENCY_FILE =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|bun\.lock|go\.mod|Cargo\.toml|requirements\.txt|poetry\.lock)$/;
const INFRA_FILE = /(^|\/)(Dockerfile|dockerfile|docker-compose[^/]*)$|\.tf$/;
const PERMISSIONS_FILE = /(^|\/)(permissions?|acl|rbac)(?:\/|$)/i;
const PAYMENTS_FILE = /(^|\/)(payments?|billing|checkout)(?:\/|$)/i;
const SECRET_FILE = /(^|\/)(keys?|secrets?|credentials?)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;

type SpreadArea =
  | "auth"
  | "permissions"
  | "payments"
  | "security"
  | "secrets"
  | "migration"
  | "dependency"
  | "infra"
  | "config";

const SPREAD_LINE: Record<SpreadArea, string> = {
  auth: "Wide spread: the diff touches auth, so a wrong change can widen access beyond this pull request.",
  permissions:
    "Wide spread: the diff touches permissions, so a wrong change can widen access beyond this pull request.",
  payments:
    "Wide spread: the diff touches payments, so a wrong change can move money or billing state.",
  security:
    "Wide spread: the diff touches security-sensitive code, so a wrong change can weaken a boundary.",
  secrets:
    "Wide spread: the diff touches secret material, so a wrong change can expose or weaken a credential.",
  migration:
    "Wide spread: the diff includes a data migration, so a wrong change can corrupt stored rows.",
  dependency:
    "Wide spread: the diff touches a dependency manifest, so a wrong change can move runtime behavior.",
  infra:
    "Wide spread: the diff touches infra, so a wrong change can affect more than the edited lines.",
  config:
    "Wide spread: the diff touches config, so a wrong change can affect runtime behavior outside the edited lines.",
};

function spreadArea(files: readonly string[]) {
  const categories = buildReviewPathProfile(files).riskCategories;
  if (categories.includes("auth")) return ((pinnedReturn: SpreadArea) => pinnedReturn)("auth");
  if (files.some((file) => PERMISSIONS_FILE.test(file)))
    return ((pinnedReturn: SpreadArea) => pinnedReturn)("permissions");
  if (files.some((file) => PAYMENTS_FILE.test(file)))
    return ((pinnedReturn: SpreadArea) => pinnedReturn)("payments");
  if (categories.includes("security"))
    return ((pinnedReturn: SpreadArea) => pinnedReturn)("security");
  if (files.some((file) => SECRET_FILE.test(file)))
    return ((pinnedReturn: SpreadArea) => pinnedReturn)("secrets");
  if (categories.includes("migration"))
    return ((pinnedReturn: SpreadArea) => pinnedReturn)("migration");
  if (files.some((file) => DEPENDENCY_FILE.test(file)))
    return ((pinnedReturn: SpreadArea) => pinnedReturn)("dependency");
  if (files.some((file) => INFRA_FILE.test(file)))
    return ((pinnedReturn: SpreadArea) => pinnedReturn)("infra");
  if (categories.includes("config")) return ((pinnedReturn: SpreadArea) => pinnedReturn)("config");
  return ((pinnedReturn: SpreadArea | null) => pinnedReturn)(null);
}

function assessMergeability(files: readonly string[], listed: boolean, truncated: boolean) {
  if (!listed)
    return ((pinnedReturn: string) => pinnedReturn)(
      "Reversibility is unknown: the changed-file list was unavailable, so an omitted migration cannot be ruled out.",
    );
  if (truncated)
    return ((pinnedReturn: string) => pinnedReturn)(
      "Reversibility is unknown: the changed-file list was truncated, so an omitted file could hold a destructive migration.",
    );
  if (buildReviewPathProfile(files).riskCategories.includes("migration"))
    return ((pinnedReturn: string) => pinnedReturn)(
      "Hard to undo: the diff includes a data migration, so rollback does not restore prior stored rows.",
    );
  if (files.length === 0)
    return ((pinnedReturn: string) => pinnedReturn)(
      "Easy to revert: no changed files were listed, so there is no irreversible data change.",
    );
  return ((pinnedReturn: string) => pinnedReturn)(
    "Easy to revert: the listed files have no migration or other irreversible data change.",
  );
}

function assessBlastRadius(files: readonly string[], listed: boolean, truncated: boolean) {
  if (!listed)
    return ((pinnedReturn: string) => pinnedReturn)(
      "Wide spread: the changed-file list was unavailable, so impact if wrong cannot be bounded to the diff.",
    );
  const area = spreadArea(files);
  if (area != null) return ((pinnedReturn: string) => pinnedReturn)(SPREAD_LINE[area]);
  if (truncated)
    return ((pinnedReturn: string) => pinnedReturn)(
      "Wide spread: the changed-file list was truncated, so a sensitive path may sit outside the listed files.",
    );
  if (files.length === 0)
    return ((pinnedReturn: string) => pinnedReturn)(
      "Narrow spread: no changed files were listed, so the diff does not touch a sensitive area.",
    );
  return ((pinnedReturn: string) => pinnedReturn)(
    "Wide spread: listed names match no sensitive path class, and an unmatched name is not proof the change is contained.",
  );
}

function needsAssessment(value: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(value.trim() === REVIEW_GATE_PROSE_UNASSESSED);
}

export function payloadWithAssessedGateProse(
  payload: ReviewPayload,
  index: CachedPrDiffIndex | undefined,
) {
  const mergeabilityMissing = needsAssessment(payload.mergeability);
  const blastRadiusMissing = needsAssessment(payload.blastRadius);
  if (!mergeabilityMissing && !blastRadiusMissing)
    return ((pinnedReturn: ReviewPayload) => pinnedReturn)(payload);
  const listed = index != null && index.listPullRequestFilesIngested;
  const files = listed ? [...index.files.keys()] : [];
  const truncated = listed && index.truncated;
  return ((pinnedReturn: ReviewPayload) => pinnedReturn)({
    ...payload,
    ...(mergeabilityMissing ? { mergeability: assessMergeability(files, listed, truncated) } : {}),
    ...(blastRadiusMissing ? { blastRadius: assessBlastRadius(files, listed, truncated) } : {}),
  });
}
