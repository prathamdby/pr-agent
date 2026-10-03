import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { AgentRunnerToolExecutor } from "../providers/interface.js";
import { type Config, DESCRIPTION_PUBLISH_LENS } from "../../settings/index.js";
import type { PrSurface } from "../../github/prSurface.js";
import { AppError } from "../../errors/appError.js";
import { logDebug, logInfo } from "../../evlog.js";
import { planDescriptionPublish } from "./descriptionPublishPlan.js";
import {
  coerceDescriptionPayloadInput,
  descriptionPayloadSchema,
  DESCRIPTION_PAYLOAD_BASE_EXAMPLE,
} from "./descriptionSchema.js";
import { parseToolInput } from "../tools/parseToolInput.js";
import {
  enforceDescriptionMapPayload,
  type DescriptionMapMode,
} from "./descriptionWritingPolicy.js";
import { enforceDescriptionTitle } from "./descriptionTitle.js";
import {
  enforceDescriptionVisualPayload,
  formatDescriptionVisualValidationError,
  validateDescriptionVisuals,
} from "./descriptionVisualSanitize.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import {
  descriptionPrBodyOperationKey,
  operationIntentMarker,
  type OperationIntentContext,
  publishOnce,
} from "../../agentWork/publishOnce.js";

type DescriptionPublishResult = {
  readonly prNumber: number;
  readonly bodyUpdated: boolean;
  readonly titleUpdated?: boolean;
};

export type SubmitDescriptionState = {
  published: boolean;
  lastValidationError: string | null;
  publishSuperseded: boolean;
};

export function createSubmitDescriptionState(): SubmitDescriptionState {
  return {
    published: false,
    lastValidationError: null,
    publishSuperseded: false,
  };
}

const SUBMIT_DESCRIPTION_DESCRIPTION = [
  "Submit the completed PR description exactly once.",
  "Pass a DescriptionPayload object matching the schema.",
  "This merges generated content into the pull request body under the PR Agent description header.",
  `Shape-only example (active map hard rule decides prFiles): ${JSON.stringify(DESCRIPTION_PAYLOAD_BASE_EXAMPLE)}`,
].join(" ");

const SUBMIT_DESCRIPTION_PARAMETERS = toJsonSchema(descriptionPayloadSchema, {
  errorMode: "ignore",
}) as PiTool["parameters"];

export function buildSubmitDescriptionTool(params: {
  cfg: Config;
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  state: SubmitDescriptionState;
  mapMode: DescriptionMapMode;
  knownPaths?: ReadonlySet<string>;
  shouldAbortPublish?: () => Promise<boolean>;
  recordPublishStep?: (detail?: Record<string, unknown>) => Promise<void>;
  operationIntent?: OperationIntentContext;
}): {
  piTool: PiTool;
  executor: AgentRunnerToolExecutor;
} {
  const piTool: PiTool = {
    name: "submitDescription",
    description: SUBMIT_DESCRIPTION_DESCRIPTION,
    parameters: SUBMIT_DESCRIPTION_PARAMETERS,
  };

  const executor: AgentRunnerToolExecutor = async (args) => {
    if (params.state.published) {
      logDebug("description_submit_duplicate_ignored", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
      });
      return { ok: true, duplicate: true };
    }

    if (params.shouldAbortPublish && (await params.shouldAbortPublish())) {
      params.state.publishSuperseded = true;
      throw new AppError({
        domain: "description",
        kind: "publish_superseded",
        message: "Description publish aborted because this work item was superseded or cancelled.",
      });
    }

    const coerced = coerceDescriptionPayloadInput(args);
    const parsed = parseToolInput(descriptionPayloadSchema, coerced, {
      toolName: "submitDescription",
      errorTitle: "DescriptionPayload validation failed:",
    });
    if (!parsed.ok) {
      params.state.lastValidationError = parsed.error;
      throw new AppError({
        domain: "description",
        kind: "validation_failed",
        message: params.state.lastValidationError,
      });
    }

    let payload = parsed.value;
    payload = enforceDescriptionVisualPayload(payload);
    const visualIssues = validateDescriptionVisuals(payload.visuals ?? []);
    if (visualIssues.length > 0) {
      params.state.lastValidationError = formatDescriptionVisualValidationError(visualIssues);
      throw new AppError({
        domain: "description",
        kind: "validation_failed",
        message: params.state.lastValidationError,
      });
    }

    payload = { ...payload, title: enforceDescriptionTitle(payload.title) };

    const enforced = enforceDescriptionMapPayload(payload, params.mapMode, {
      knownPaths: params.knownPaths,
    });
    payload = enforced.payload;
    if (enforced.strippedCount > 0) {
      logInfo("description_map_omit_stripped", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        strippedCount: enforced.strippedCount,
        mapMode: params.mapMode,
      });
    }
    if (enforced.cappedFrom != null) {
      logInfo("description_map_capped", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        from: enforced.cappedFrom,
        mapMode: params.mapMode,
      });
    }

    params.state.lastValidationError = null;

    const operationIntent = params.operationIntent;
    const operationKey =
      operationIntent == null ? null : descriptionPrBodyOperationKey(operationIntent.resourceKey);
    const operationMarker =
      operationIntent == null
        ? null
        : operationIntentMarker(
            descriptionPrBodyOperationKey(operationIntent.resourceKey),
            operationIntent.workItemId,
          );
    const publish = async (): Promise<DescriptionPublishResult> => {
      const { pullRequest } = await params.prSurface.getHead();
      const plan = planDescriptionPublish({
        cfg: params.cfg,
        pullRequest,
        resource: { owner: params.owner, repo: params.repo, prNumber: params.prNumber },
        payload,
        operationMarker: operationMarker ?? undefined,
      });
      if (plan.titleUpdated || plan.bodyUpdated) {
        await params.prSurface.updatePullRequest(
          { title: plan.title, body: plan.body },
          operationMarker ?? undefined,
        );
      }
      return {
        prNumber: params.prNumber,
        titleUpdated: plan.titleUpdated,
        bodyUpdated: plan.bodyUpdated,
      };
    };

    const result =
      params.operationIntent == null
        ? await publish()
        : await publishOnce<DescriptionPublishResult>({
            client: params.operationIntent.client,
            workItemId: params.operationIntent.workItemId,
            operationKey:
              operationKey ?? descriptionPrBodyOperationKey(params.operationIntent.resourceKey),
            mutationKind: "github.pr_body",
            leaseEpoch: params.operationIntent.leaseEpoch,
            detail: {
              step: "pr_body",
              resourceKey: params.operationIntent.resourceKey,
              reviewLens: DESCRIPTION_PUBLISH_LENS,
              ...(operationMarker == null ? {} : { operationMarker }),
            },
            recover: async () => {
              const { pullRequest } = await params.prSurface.getHead();
              return pullRequest.body?.includes(operationMarker ?? "\u0000")
                ? {
                    kind: "reconciled" as const,
                    value: { prNumber: params.prNumber, bodyUpdated: true },
                  }
                : { kind: "absent" as const };
            },
            isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
            mutate: publish,
          });

    params.state.published = true;
    logInfo("description_published", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      titleUpdated: result.titleUpdated,
      bodyUpdated: result.bodyUpdated,
      mapMode: params.mapMode,
      mapEntries: payload.prFiles?.length ?? 0,
      visualCount: payload.visuals?.length ?? 0,
    });

    if (params.recordPublishStep) {
      await params.recordPublishStep({
        titleUpdated: result.titleUpdated,
        bodyUpdated: result.bodyUpdated,
      });
    }

    return { ok: true, ...result };
  };

  return { piTool, executor };
}
