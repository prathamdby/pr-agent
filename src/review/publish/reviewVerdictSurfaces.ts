import * as v from "valibot";
import { decodeCheckRef } from "../../github/prSurfaceResults.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { InstallationOperation } from "../../github/installationCapabilities.ts";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.ts";
import { DEFERRED_HEAD_SHA, type AnyReviewLens } from "../../settings/index.ts";
import { logWarn } from "../../evlog.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import {
  ownVerdictSurfaces,
  reviewCheckDetailsUrl,
  reviewCheckRunName,
  type OwnVerdictOutcome,
} from "../../agentWork/reviewVerdict.ts";
import {
  latestCommentGithubId,
  publishOnce,
  retainFirstVerdict,
  reviewCheckCloseOperationKey,
  reviewCheckOperationKey,
  reviewCommitStatusOperationKey,
  workPublishRecord,
  writePublishStep,
} from "../../state/publish.ts";
import type { ReviewPublishTarget } from "./reviewPublishSession.ts";

export type ReviewVerdictSurfaceParams = {
  readonly target: ReviewPublishTarget;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly reviewLens: AnyReviewLens;
  readonly headSha: string;
  readonly commitStatusEnabled: boolean;
  readonly summaryCommentId?: number | null;
};

const selectedVerdictSchema = v.object({
  conclusion: v.picklist(["success", "failure", "neutral", "cancelled", "action_required"]),
  summary: v.string(),
  detailsUrl: v.optional(v.string()),
  status: v.object({
    headSha: v.string(),
    enabled: v.boolean(),
    state: v.picklist(["success", "failure", "error"]),
  }),
});
type SelectedVerdict = v.InferOutput<typeof selectedVerdictSchema>;

function hasAccess(surface: PrSurface, operation: InstallationOperation) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    surface.capabilities == null || surface.capabilities.access(operation) === "available",
  );
}

function publishBase(target: ReviewPublishTarget) {
  return {
    db: target.db,
    workId: target.workItemId,
    prKey: target.resourceKey,
    ...(target.laneEpoch !== undefined ? { laneEpoch: target.laneEpoch } : {}),
    ...(target.shutdownRequested !== undefined
      ? { shutdownRequested: target.shutdownRequested }
      : {}),
    ...(target.gate !== undefined ? { gate: target.gate } : {}),
    ...(target.signal !== undefined ? { signal: target.signal } : {}),
  };
}

function selectedFromJson(value: Record<string, unknown>) {
  const parsed = v.safeParse(selectedVerdictSchema, value);
  return ((pinnedReturn: SelectedVerdict | undefined) => pinnedReturn)(
    parsed.success ? parsed.output : undefined,
  );
}

function checkRunId(params: ReviewVerdictSurfaceParams) {
  const record = workPublishRecord(params.target.db, params.target.workItemId, "check_run");
  return ((pinnedReturn: number | null) => pinnedReturn)(record?.githubId ?? null);
}

async function startCheck(params: ReviewVerdictSurfaceParams) {
  const existing = checkRunId(params);
  if (existing != null) return ((pinnedReturn: number | null) => pinnedReturn)(existing);
  if (!hasAccess(params.prSurface, "checksWrite"))
    return ((pinnedReturn: number | null) => pinnedReturn)(null);
  const workItemId = params.target.workItemId;
  try {
    const check = await publishOnce({
      ...publishBase(params.target),
      resourceTarget: `check_run:${workItemId}`,
      operationKey: reviewCheckOperationKey(workItemId),
      mutationKind: "github.review_check_run",
      identity: {
        step: "check_run",
        resourceKey: params.target.resourceKey,
        reviewLens: params.reviewLens,
        headSha: params.headSha,
        externalId: workItemId,
        name: reviewCheckRunName(),
      },
      decodeResult: decodeCheckRef,
      recover: async () => {
        if (!hasAccess(params.prSurface, "checksRead")) return { found: false as const };
        const found = await params.prSurface.findReviewCheck(params.headSha, workItemId);
        return found == null ? { found: false as const } : { found: true as const, value: found };
      },
      isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
      mutate: () =>
        params.prSurface.startReviewCheck(
          params.headSha,
          workItemId,
          "PR Agent review is in progress.",
        ),
    });
    writePublishStep(params.target.db, {
      workId: workItemId,
      prKey: params.target.resourceKey,
      reviewLens: params.reviewLens,
      step: "check_run",
      githubId: check.id,
      detail: { status: "in_progress", headSha: params.headSha, name: reviewCheckRunName() },
    });
    return ((pinnedReturn: number | null) => pinnedReturn)(check.id);
  } catch (error) {
    logWarn("review_check_run_start_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      message: errorMessage(error),
    });
    return ((pinnedReturn: number | null) => pinnedReturn)(null);
  }
}

async function writeStatus(
  params: ReviewVerdictSurfaceParams,
  status: {
    readonly state: SelectedVerdict["status"]["state"] | "pending";
    readonly description: string;
    readonly targetUrl?: string;
  },
) {
  if (params.headSha === DEFERRED_HEAD_SHA || params.headSha.length === 0) return false;
  if (!hasAccess(params.prSurface, "statusesWrite")) return false;
  try {
    await publishOnce({
      ...publishBase(params.target),
      resourceTarget: `commit_status:${params.headSha}`,
      operationKey: reviewCommitStatusOperationKey(
        params.target.resourceKey,
        params.headSha,
        status.state,
      ),
      mutationKind: "github.review_commit_status",
      blocksOverwrite: true,
      failClosed: true,
      allowsUndefinedResult: true,
      identity: {
        step: "commit_status",
        resourceKey: params.target.resourceKey,
        headSha: params.headSha,
        context: "pr-agent/review",
        ...status,
      },
      isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
      mutate: () => params.prSurface.setReviewCommitStatus(params.headSha, status),
    });
    return true;
  } catch (error) {
    logWarn("review_commit_status_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      headSha: params.headSha,
      state: status.state,
      message: errorMessage(error),
    });
    return false;
  }
}

export function reviewVerdictSurfaces(params: ReviewVerdictSurfaceParams) {
  const detailsUrl = () =>
    reviewCheckDetailsUrl(
      params.owner,
      params.repo,
      params.prNumber,
      params.summaryCommentId === undefined
        ? latestCommentGithubId(params.target.db, params.target.resourceKey, params.reviewLens)
        : params.summaryCommentId,
    );
  return {
    pending: async () => {
      const id = await startCheck(params);
      if (params.commitStatusEnabled) {
        const targetUrl = detailsUrl();
        await writeStatus(params, {
          state: "pending",
          description: "PR Agent review is in progress.",
          ...(targetUrl !== undefined ? { targetUrl } : {}),
        });
      }
      return id;
    },
    close: async (outcome: OwnVerdictOutcome) => {
      const surfaces = ownVerdictSurfaces(outcome);
      const url = detailsUrl();
      const candidate: SelectedVerdict = {
        conclusion: surfaces.checkRun,
        summary: surfaces.summary,
        ...(url !== undefined ? { detailsUrl: url } : {}),
        status: {
          headSha: params.headSha,
          enabled: params.commitStatusEnabled,
          state: surfaces.commitStatus,
        },
      };
      const retained = retainFirstVerdict(params.target.db, {
        prKey: params.target.resourceKey,
        workId: params.target.workItemId,
        reviewLens: params.reviewLens,
        verdict: candidate,
      });
      const selected = selectedFromJson(retained.verdict) ?? candidate;
      const id = checkRunId(params) ?? (await startCheck(params));
      if (id != null) {
        try {
          await publishOnce({
            ...publishBase(params.target),
            resourceTarget: `check_run:${params.target.workItemId}`,
            operationKey: reviewCheckCloseOperationKey(params.target.workItemId, params.reviewLens),
            mutationKind: "github.review_check_run_close",
            blocksOverwrite: true,
            allowsUndefinedResult: true,
            identity: {
              step: "check_run",
              checkRunId: id,
              conclusion: selected.conclusion,
            },
            isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
            mutate: () =>
              params.prSurface.finishReviewCheck({
                checkRunId: id,
                conclusion: selected.conclusion,
                summary: selected.summary,
                name: reviewCheckRunName(),
                ...(selected.detailsUrl !== undefined ? { detailsUrl: selected.detailsUrl } : {}),
              }),
          });
          writePublishStep(params.target.db, {
            workId: params.target.workItemId,
            prKey: params.target.resourceKey,
            reviewLens: params.reviewLens,
            step: "check_run",
            githubId: id,
            detail: {
              status: "completed",
              conclusion: selected.conclusion,
              selectedOwnVerdict: selected,
              ownCheckApplied: true,
            },
          });
        } catch (error) {
          logWarn("review_check_run_close_failed", {
            owner: params.owner,
            repo: params.repo,
            pr: params.prNumber,
            reviewLens: params.reviewLens,
            message: errorMessage(error),
          });
        }
      }
      if (selected.status.enabled && selected.status.headSha.length > 0) {
        await writeStatus(params, {
          state: selected.status.state,
          description: selected.summary,
          ...(selected.detailsUrl !== undefined ? { targetUrl: selected.detailsUrl } : {}),
        });
      }
      return selected;
    },
  };
}
