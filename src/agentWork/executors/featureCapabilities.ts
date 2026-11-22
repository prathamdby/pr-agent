import type { DatabaseSync } from "node:sqlite";
import type { InstallationToken } from "../../github/appAuth.ts";
import {
  capabilityObservationUnconfirmed,
  createReviewCapabilityPolicy,
  unknownInstallationCapabilities,
  type InstallationCapabilities,
  type ReviewCapabilityPolicy,
} from "../../github/installationCapabilities.ts";
import type {
  AcknowledgementTarget,
  PrSurface,
  PrSurfaceMutationBoundary,
} from "../../github/prSurface.ts";
import type { Config, GithubReactionContent } from "../../settings/index.ts";
import { logWarn } from "../../evlog.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import type { FeaturePublication } from "../../state/featurePublication.ts";
import {
  loadGithubCapabilityObservation,
  nextGithubCapabilityObservationGeneration,
  recordGithubCapabilityDenial,
  saveGithubCapabilityObservation,
  type GithubRepositoryScope,
} from "../../state/githubCapabilities.ts";
import type { InstallationSurface } from "../installationSurface.ts";

export type InstallationPolicy = {
  readonly capabilities: ReviewCapabilityPolicy;
  readonly installation: InstallationToken | undefined;
  readonly preflighted: boolean;
};

export function passthroughMutationBoundary(signal?: AbortSignal) {
  return ((pinnedReturn: PrSurfaceMutationBoundary) => pinnedReturn)({
    signal: signal ?? new AbortController().signal,
    confirmLeaseHeld: () => Promise.resolve(),
    run: (_mutation, mutate) => mutate(),
  });
}

export async function resolveInstallationPolicy(params: {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly installationSurface: InstallationSurface;
  readonly scope: GithubRepositoryScope;
  readonly signal?: AbortSignal;
  readonly now: () => number;
}) {
  const { db, cfg, scope } = params;
  const stored = loadGithubCapabilityObservation(db, scope);
  let observation: InstallationCapabilities;
  let installation: InstallationToken | undefined;
  let preflighted = false;
  if (stored !== undefined && !capabilityObservationUnconfirmed(stored.capabilities)) {
    const unknown = unknownInstallationCapabilities(
      { ...scope, appId: cfg.github.appId },
      String(stored.generation),
    );
    observation = { ...unknown, availability: { ...unknown.availability, ...stored.capabilities } };
    installation = await params.installationSurface.scopedToken({ cfg, ...scope });
  } else {
    const fresh = await params.installationSurface.preflight({
      cfg,
      ...scope,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      generation: String(nextGithubCapabilityObservationGeneration(db)),
    });
    observation = fresh.observation;
    installation = fresh.installation;
    preflighted = true;
    saveGithubCapabilityObservation(db, { ...scope, observation, now: params.now() });
  }
  const capabilities = createReviewCapabilityPolicy(observation, async (operation) => {
    recordGithubCapabilityDenial(db, {
      ...scope,
      generation: Number(observation.generation),
      operation,
      now: params.now(),
    });
  });
  return ((pinnedReturn: InstallationPolicy) => pinnedReturn)({
    capabilities,
    installation,
    preflighted,
  });
}

export function canWrite(prSurface: PrSurface, operation: "commentsWrite" | "reactionsWrite") {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    (prSurface.capabilities?.access(operation) ?? "available") === "available",
  );
}

function reactionTargetKey(target: AcknowledgementTarget) {
  return ((pinnedReturn: string) => pinnedReturn)(
    target.kind === "pr" ? `pr:${target.prNumber}` : `${target.kind}:${target.commentId}`,
  );
}

export async function publishReactions(params: {
  readonly publication: FeaturePublication;
  readonly prSurface: PrSurface;
  readonly targets: readonly AcknowledgementTarget[];
  readonly content: GithubReactionContent;
  readonly prKey?: string;
  readonly logEvent: string;
  readonly logFields?: Record<string, unknown>;
}) {
  if (!canWrite(params.prSurface, "reactionsWrite")) return;
  for (const target of params.targets) {
    const targetKey = reactionTargetKey(target);
    try {
      await params.publication.once({
        decodeResult: () => undefined,
        allowsUndefinedResult: true,
        ...(params.prKey !== undefined ? { prKey: params.prKey } : {}),
        resourceTarget: `reaction:${targetKey}`,
        operationKey: `reaction:${targetKey}:${params.content}`,
        mutationKind: "github.reaction",
        identity: { target: targetKey, content: params.content },
        mutate: () => params.prSurface.setAcknowledgementReaction([target], params.content),
      });
    } catch (error) {
      logWarn(params.logEvent, {
        ...params.logFields,
        reaction: params.content,
        target: targetKey,
        message: errorMessage(error),
      });
    }
  }
}
