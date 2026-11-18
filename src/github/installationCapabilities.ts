import { AppError } from "../errors/appError.ts";
import { httpStatus } from "./httpStatus.ts";

export const installationOperations = [
  "pullRequestsRead",
  "contentsRead",
  "reviewWrite",
  "commentsWrite",
  "checksRead",
  "checksWrite",
  "statusesRead",
  "statusesWrite",
  "actionsRead",
  "labelsRead",
  "labelsWrite",
  "reactionsWrite",
] as const;
export type InstallationOperation = (typeof installationOperations)[number];
export type CapabilityAvailability = "available" | "denied" | "unknown";
export type InstallationPermissions = Readonly<Record<string, string>>;
export function parseInstallationPermissions(value: unknown) {
  if (typeof value !== "object" || value == null || Array.isArray(value))
    return ((pinnedReturn: InstallationPermissions | undefined) => pinnedReturn)(undefined);
  const permissions: Record<string, string> = {};
  for (const [key, grant] of Object.entries(value)) {
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      (grant !== "read" && grant !== "write" && grant !== "admin")
    )
      return ((pinnedReturn: InstallationPermissions | undefined) => pinnedReturn)(undefined);
    if (
      grant === "admin" &&
      Object.values(permissionAlternatives).some((alternatives) =>
        alternatives.some(([permission]) => permission === key),
      )
    )
      return ((pinnedReturn: InstallationPermissions | undefined) => pinnedReturn)(undefined);
    permissions[key] = grant;
  }
  return ((pinnedReturn: InstallationPermissions | undefined) => pinnedReturn)(permissions);
}
export type InstallationCapabilityScope = {
  readonly appId: string | number;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
};
export type InstallationCapabilities = {
  readonly scope: InstallationCapabilityScope;
  readonly generation: string;
  readonly availability: Readonly<Record<InstallationOperation, CapabilityAvailability>>;
  readonly permissions?: InstallationPermissions;
};

const permissionAlternatives: Record<InstallationOperation, readonly [string, "read" | "write"][]> =
  {
    pullRequestsRead: [["pull_requests", "read"]],
    contentsRead: [["contents", "read"]],
    reviewWrite: [["pull_requests", "write"]],
    commentsWrite: [
      ["issues", "write"],
      ["pull_requests", "write"],
    ],
    checksRead: [["checks", "read"]],
    checksWrite: [["checks", "write"]],
    statusesRead: [["statuses", "read"]],
    statusesWrite: [["statuses", "write"]],
    actionsRead: [["actions", "read"]],
    labelsRead: [
      ["issues", "read"],
      ["pull_requests", "read"],
    ],
    labelsWrite: [
      ["issues", "write"],
      ["pull_requests", "write"],
    ],
    reactionsWrite: [
      ["issues", "write"],
      ["pull_requests", "write"],
    ],
  };
export const essentialInstallationOperations = [
  "pullRequestsRead",
  "contentsRead",
  "reviewWrite",
  "commentsWrite",
] as const satisfies readonly InstallationOperation[];

function uniformCapabilities(
  scope: InstallationCapabilityScope,
  generation: string,
  value: CapabilityAvailability,
) {
  return ((pinnedReturn: InstallationCapabilities) => pinnedReturn)({
    scope,
    generation,
    availability: operationAvailability(() => value),
  });
}

function operationAvailability(
  access: (operation: InstallationOperation) => CapabilityAvailability,
) {
  return ((pinnedReturn: Record<InstallationOperation, CapabilityAvailability>) => pinnedReturn)({
    pullRequestsRead: access("pullRequestsRead"),
    contentsRead: access("contentsRead"),
    reviewWrite: access("reviewWrite"),
    commentsWrite: access("commentsWrite"),
    checksRead: access("checksRead"),
    checksWrite: access("checksWrite"),
    statusesRead: access("statusesRead"),
    statusesWrite: access("statusesWrite"),
    actionsRead: access("actionsRead"),
    labelsRead: access("labelsRead"),
    labelsWrite: access("labelsWrite"),
    reactionsWrite: access("reactionsWrite"),
  });
}
export function availableInstallationCapabilities(
  scope: InstallationCapabilityScope,
  generation = "0",
) {
  return ((pinnedReturn: InstallationCapabilities) => pinnedReturn)(
    uniformCapabilities(scope, generation, "available"),
  );
}
export function deniedInstallationCapabilities(
  scope: InstallationCapabilityScope,
  generation: string,
) {
  return ((pinnedReturn: InstallationCapabilities) => pinnedReturn)(
    uniformCapabilities(scope, generation, "denied"),
  );
}
export function unknownInstallationCapabilities(
  scope: InstallationCapabilityScope,
  generation: string,
) {
  return ((pinnedReturn: InstallationCapabilities) => pinnedReturn)(
    uniformCapabilities(scope, generation, "unknown"),
  );
}
export function installationCapabilitiesFromPermissions(params: {
  readonly scope: InstallationCapabilityScope;
  readonly generation: string;
  readonly permissions: InstallationPermissions;
}) {
  const availability = operationAvailability((operation) =>
    permissionAlternatives[operation].some(([permission, required]) => {
      const grant = params.permissions[permission];
      return grant === "write" || (required === "read" && grant === "read");
    })
      ? "available"
      : "denied",
  );
  return ((pinnedReturn: InstallationCapabilities) => pinnedReturn)({ ...params, availability });
}
export function capabilityObservationUnconfirmed(
  availability: Partial<Record<InstallationOperation, CapabilityAvailability>>,
) {
  return ((pinnedReturn: boolean) => pinnedReturn)(Object.values(availability).includes("unknown"));
}
export function essentialCapabilitiesDenied(observation: InstallationCapabilities) {
  return essentialInstallationOperations.filter(
    (operation) => observation.availability[operation] === "denied",
  );
}
export function assertEssentialInstallationCapabilities(observation: InstallationCapabilities) {
  const denied = essentialCapabilitiesDenied(observation);
  if (denied.length) {
    throw new AppError({
      domain: "github",
      kind: "essential_access_denied",
      message: "GitHub installation lacks essential repository access",
      context: { operations: denied, ...observation.scope, generation: observation.generation },
    });
  }
  if (essentialInstallationOperations.some((op) => observation.availability[op] === "unknown")) {
    throw new AppError({
      domain: "github",
      kind: "preflight_unavailable",
      message: "GitHub installation access could not be confirmed",
    });
  }
}
export type ReviewCapabilityPolicy = {
  readonly observation: InstallationCapabilities;
  access(operation: InstallationOperation): CapabilityAvailability;
  deny(operation: InstallationOperation): Promise<void>;
};
export function createReviewCapabilityPolicy(
  observation: InstallationCapabilities,
  onDenied?: (operation: InstallationOperation) => Promise<void>,
) {
  const denied = new Set<InstallationOperation>();
  return ((pinnedReturn: ReviewCapabilityPolicy) => pinnedReturn)({
    observation,
    access: (operation) => (denied.has(operation) ? "denied" : observation.availability[operation]),
    async deny(operation) {
      if (denied.has(operation)) return;
      denied.add(operation);
      await onDenied?.(operation);
    },
  });
}

export function isConfirmedCapabilityDenial(error: unknown) {
  if (httpStatus(error) !== 403 || !(error instanceof Error))
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    /resource not accessible by integration|resource not accessible by personal access token|insufficient permissions/i.test(
      error.message,
    ),
  );
}
