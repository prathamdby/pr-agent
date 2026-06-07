import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { fetchPullRequestFiles } from "../../github/listPullRequestFiles.js";
import { logInfo, logWarn } from "../../evlog.js";
import {
  FIX_NO_TARGETS,
  FIX_PUSH_STALE,
  FIX_TARGET_STALE,
  FIX_TARGET_UNMAPPED,
  FIX_UNAUTHORIZED,
} from "../../settings/index.js";
import {
  findAutoFixTargetByInlineComment,
  findAutoFixTargetByInlineLocation,
  findLatestAutoFixTargetsByLens,
} from "../../autoFix/repository.js";
import { groupAutoFixTargets } from "../../autoFix/groupTargets.js";
import {
  createOrReuseFallbackPullRequest,
  getBranchHeadSha,
  getPullRequestBranchContext,
  getRepositoryPermission,
  isCommitReachableFromHead,
  permissionCanAutoFix,
  type PullRequestBranchContext,
} from "../../autoFix/github.js";
import { renderAutoFixFinalReply, type AutoFixSkippedTarget } from "../../autoFix/reply.js";
import { runAutoFixTargetGroup } from "../../autoFix/run.js";
import { prepareAutoFixWorkspace, type AutoFixCommit } from "../../autoFix/workspace.js";
import type { AutoFixTarget, AutoFixTargetGroup } from "../../autoFix/types.js";
import { findPullRequestReviewCommentThreadRoot } from "../../github/reviewCommentThreads.js";
import { getAppBotIdentity, postSlashReply } from "../githubPrSurface.js";
import { resolveWorkItemHeadSha, runDurableWorkItem } from "../durableJob.js";
import { findActiveFixConflict } from "../intake/workItemRepository.js";
import { recordFixPublishCheckpoint } from "../repository.js";
import type {
  FixJobData,
  FixPublishCheckpoint,
  FixPublishReplyState,
  FixTargetSelector,
  FixWorkPayload,
} from "../types.js";

const FIX_ALL_LENSES = ["review", "review-security", "review-quality"] as const;

type PublishedRecovery =
  | { readonly kind: "alreadyReplied" }
  | {
      readonly kind: "needsReply";
      readonly checkpoint: Extract<FixPublishCheckpoint, { kind: "direct" | "fallback" }>;
    }
  | {
      readonly kind: "needsFallbackPr";
      readonly checkpoint: Extract<FixPublishCheckpoint, { kind: "fallbackBranch" }>;
    };

type ResolvedFixTargetSelector =
  | {
      readonly selector: Extract<FixTargetSelector, { kind: "inline" }>;
      readonly inlineLocation: { readonly filePath: string; readonly line: number } | null;
    }
  | {
      readonly selector: Extract<FixTargetSelector, { kind: "all" }>;
      readonly inlineLocation?: never;
    };

function commitMessageForGroup(group: AutoFixTargetGroup): string {
  const first = group.targets[0];
  if (!first) return "Auto-fix PR Agent findings";
  const raw =
    group.targets.length === 1
      ? `Auto-fix ${first.severity}: ${first.title}`
      : `Auto-fix ${group.targets.length} PR Agent findings`;
  return raw.length > 72 ? raw.slice(0, 69).trimEnd() + "..." : raw;
}

function fallbackBranchName(workItemId: string, prNumber: number): string {
  return `pr-agent/fix/pr-${prNumber}-${workItemId.slice(0, 12)}`;
}

function fallbackPullRequestBody(workItemId: string, prNumber: number): string {
  return [`Auto-fix replacement for #${prNumber}.`, "", `Work item: ${workItemId}`].join("\n");
}

function changedPathsFromCommits(commits: readonly AutoFixCommit[]): string[] {
  return [...new Set(commits.flatMap((commit) => commit.changedPaths))].toSorted();
}

function publishReplyState(
  commits: readonly AutoFixCommit[],
  skipped: readonly AutoFixSkippedTarget[],
): FixPublishReplyState {
  return {
    commits: commits.map((commit) => ({
      sha: commit.sha,
      message: commit.message,
    })),
    skipped: skipped.map(({ target, reason }) => ({
      target: {
        severity: target.severity,
        filePath: target.filePath,
        startLine: target.startLine,
        title: target.title,
      },
      reason,
    })),
    changedPaths: changedPathsFromCommits(commits),
  };
}

function repositoryParts(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid GitHub repository full name: ${fullName}`);
  return { owner, repo };
}

async function recoverPublishedReply(
  token: string,
  payload: FixWorkPayload,
  branchContext: PullRequestBranchContext,
): Promise<PublishedRecovery | null> {
  const checkpoint = payload.publishCheckpoint;
  if (!checkpoint) return null;
  if (checkpoint.kind === "fallback") {
    return checkpoint.replyPosted ? { kind: "alreadyReplied" } : { kind: "needsReply", checkpoint };
  }
  if (checkpoint.kind === "fallbackBranch") {
    const branchHeadSha = await getBranchHeadSha(
      token,
      checkpoint.baseOwner,
      checkpoint.baseRepo,
      checkpoint.branch,
    );
    return branchHeadSha === checkpoint.headSha ? { kind: "needsFallbackPr", checkpoint } : null;
  }
  const headRepo = repositoryParts(branchContext.headRepoFullName);
  const reachable = await isCommitReachableFromHead(
    token,
    headRepo.owner,
    headRepo.repo,
    checkpoint.headSha,
    branchContext.headSha,
  );
  if (!reachable) return null;
  return checkpoint.replyPosted ? { kind: "alreadyReplied" } : { kind: "needsReply", checkpoint };
}

function publishedHeadSha(commits: readonly AutoFixCommit[]): string {
  const headSha = commits.at(-1)?.sha;
  if (!headSha) throw new Error("Auto-fix publish checkpoint requires at least one commit");
  return headSha;
}

async function postFixReply(
  token: string,
  item: {
    owner: string;
    repo: string;
    prNumber: number;
    payload: FixWorkPayload;
  },
  body: string,
): Promise<void> {
  await postSlashReply(token, item.owner, item.repo, item.payload.replyTarget, body);
}

async function resolveTargets(
  pool: Pool,
  item: {
    resourceKey: string;
    selector: FixTargetSelector;
    inlineLocation?: { readonly filePath: string; readonly line: number } | null;
  },
): Promise<AutoFixTarget[]> {
  const selector = item.selector;
  if (selector.kind === "inline") {
    const target = await findAutoFixTargetByInlineComment(pool, {
      resourceKey: item.resourceKey,
      inlineReviewCommentId: selector.inlineReviewCommentId,
    });
    if (target) return [target];
    if (!item.inlineLocation) return [];
    const locationTarget = await findAutoFixTargetByInlineLocation(pool, {
      resourceKey: item.resourceKey,
      filePath: item.inlineLocation.filePath,
      line: item.inlineLocation.line,
    });
    return locationTarget ? [locationTarget] : [];
  }
  return findLatestAutoFixTargetsByLens(pool, {
    resourceKey: item.resourceKey,
    lenses: FIX_ALL_LENSES,
  });
}

async function resolveFixTargetSelector(
  token: string,
  item: { owner: string; repo: string; prNumber: number; selector: FixTargetSelector },
): Promise<ResolvedFixTargetSelector> {
  const selector = item.selector;
  if (selector.kind !== "inline") return { selector };
  const root = await findPullRequestReviewCommentThreadRoot(
    token,
    item.owner,
    item.repo,
    item.prNumber,
    selector.inlineReviewCommentId,
  );
  const rootId = root?.id ?? selector.inlineReviewCommentId;
  const line = root?.line ?? root?.originalLine ?? null;
  return {
    selector:
      rootId === selector.inlineReviewCommentId
        ? selector
        : { kind: "inline", inlineReviewCommentId: rootId },
    inlineLocation: root?.path != null && line != null ? { filePath: root.path, line } : null,
  };
}

async function ensureAuthorized(
  token: string,
  item: { owner: string; repo: string; payload: FixWorkPayload },
): Promise<boolean> {
  const login = item.payload.commenterLogin;
  if (!login) return false;
  const permission = await getRepositoryPermission(token, item.owner, item.repo, login);
  return permissionCanAutoFix(permission);
}

export async function executeFixJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<FixJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "fix",
    resolveHeadSha: resolveWorkItemHeadSha,
    execute: async (item, env) => {
      const payload = item.payload as FixWorkPayload;
      const resolvedSelector = await resolveFixTargetSelector(env.installation.token, {
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        selector: payload.selector,
      });
      const selector = resolvedSelector.selector;
      const conflict = await findActiveFixConflict(pool, {
        resourceKey: item.resourceKey,
        selector,
        excludeWorkItemId: item.id,
        includeQueued: false,
      });
      if (conflict.kind !== "none") {
        await postFixReply(
          env.installation.token,
          { ...item, payload },
          "Another auto-fix run is active for this pull request.",
        );
        return {};
      }

      if (!(await ensureAuthorized(env.installation.token, { ...item, payload }))) {
        await postFixReply(env.installation.token, { ...item, payload }, FIX_UNAUTHORIZED);
        return {};
      }

      const branchContext = await getPullRequestBranchContext(
        env.installation.token,
        item.owner,
        item.repo,
        item.prNumber,
      );
      const publishedRecovery = await recoverPublishedReply(
        env.installation.token,
        payload,
        branchContext,
      );
      if (publishedRecovery?.kind === "alreadyReplied") {
        return {};
      }
      if (publishedRecovery?.kind === "needsReply") {
        await postFixReply(
          env.installation.token,
          { ...item, payload },
          publishedRecovery.checkpoint.replyBody,
        );
        await recordFixPublishCheckpoint(pool, {
          workItemId: item.id,
          checkpoint: { ...publishedRecovery.checkpoint, replyPosted: true },
        });
        return {};
      }
      if (publishedRecovery?.kind === "needsFallbackPr") {
        const checkpoint = publishedRecovery.checkpoint;
        const replacement = await createOrReuseFallbackPullRequest(env.installation.token, {
          owner: checkpoint.baseOwner,
          repo: checkpoint.baseRepo,
          headBranch: checkpoint.branch,
          baseBranch: checkpoint.baseRef,
          title: `Auto-fix PR Agent findings for #${item.prNumber}`,
          body: fallbackPullRequestBody(item.id, item.prNumber),
        });
        const replyBody = renderAutoFixFinalReply({
          ...checkpoint.replyState,
          fallbackPr: { url: replacement.url, reused: replacement.reused },
        });
        const nextCheckpoint: FixPublishCheckpoint = {
          kind: "fallback",
          headSha: checkpoint.headSha,
          replyBody,
          replyPosted: false,
        };
        await recordFixPublishCheckpoint(pool, {
          workItemId: item.id,
          checkpoint: nextCheckpoint,
        });
        await postFixReply(env.installation.token, { ...item, payload }, replyBody);
        await recordFixPublishCheckpoint(pool, {
          workItemId: item.id,
          checkpoint: { ...nextCheckpoint, replyPosted: true },
        });
        return {};
      }
      if (branchContext.headSha !== env.headSha) {
        await postFixReply(env.installation.token, { ...item, payload }, FIX_PUSH_STALE);
        return {};
      }

      const resolvedTargets = await resolveTargets(pool, {
        resourceKey: item.resourceKey,
        selector,
        inlineLocation: resolvedSelector.inlineLocation,
      });
      if (selector.kind === "inline" && resolvedTargets.length === 0) {
        await postFixReply(env.installation.token, { ...item, payload }, FIX_TARGET_UNMAPPED);
        return {};
      }

      const staleTargets = resolvedTargets.filter((target) => target.headSha !== env.headSha);
      const targets = resolvedTargets.filter((target) => target.headSha === env.headSha);
      if (targets.length === 0) {
        await postFixReply(
          env.installation.token,
          { ...item, payload },
          staleTargets.length > 0 ? FIX_TARGET_STALE : FIX_NO_TARGETS,
        );
        return {};
      }

      const prFiles = await fetchPullRequestFiles(
        env.installation.token,
        item.owner,
        item.repo,
        item.prNumber,
        {
          maxPrFilesListed: cfg.maxPrFilesListed,
          maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
        },
      );
      if (prFiles.headSha?.toLowerCase() !== env.headSha.toLowerCase()) {
        await postFixReply(env.installation.token, { ...item, payload }, FIX_PUSH_STALE);
        return {};
      }

      const bot = await getAppBotIdentity(cfg);
      const workspace = await prepareAutoFixWorkspace({
        cfg,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha: env.headSha,
        installationToken: env.installation.token,
        prFiles,
        bot,
      });

      const commits: AutoFixCommit[] = [];
      const skipped: AutoFixSkippedTarget[] = staleTargets.map((target) => ({
        target,
        reason: "Target belongs to an older PR head.",
      }));

      try {
        for (const group of groupAutoFixTargets(targets)) {
          const result = await runAutoFixTargetGroup({
            cfg,
            owner: item.owner,
            repo: item.repo,
            prNumber: item.prNumber,
            headSha: env.headSha,
            workspace,
            group,
          });

          if (result.outcome !== "fixed") {
            skipped.push(...group.targets.map((target) => ({ target, reason: result.summary })));
            await workspace.reset();
            continue;
          }

          const commit = await workspace.commitAll(commitMessageForGroup(group));
          if (!commit) {
            skipped.push(
              ...group.targets.map((target) => ({
                target,
                reason: "Agent reported a fix but produced no server-visible diff.",
              })),
            );
            await workspace.reset();
            continue;
          }
          commits.push(commit);
          logInfo("auto_fix_group_committed", {
            workItemId: item.id,
            commit: commit.sha,
            targetCount: group.targets.length,
            changedPaths: commit.changedPaths,
          });
        }

        if (commits.length > 0) {
          const replyState = publishReplyState(commits, skipped);
          const directReplyBody = renderAutoFixFinalReply(replyState);

          const latestBeforePush = await getPullRequestBranchContext(
            env.installation.token,
            item.owner,
            item.repo,
            item.prNumber,
          );
          if (latestBeforePush.headSha !== env.headSha) {
            await postFixReply(env.installation.token, { ...item, payload }, FIX_PUSH_STALE);
            return {};
          }

          const headRemoteUrl = `https://github.com/${branchContext.headRepoFullName}.git`;
          let replyBody = directReplyBody;
          let publishCheckpoint: FixPublishCheckpoint;
          try {
            await workspace.pushHeadToBranch(headRemoteUrl, branchContext.headRef);
            publishCheckpoint = {
              kind: "direct",
              headSha: publishedHeadSha(commits),
              replyBody,
              replyPosted: false,
            };
            await recordFixPublishCheckpoint(pool, {
              workItemId: item.id,
              checkpoint: publishCheckpoint,
            });
          } catch (error) {
            logWarn("auto_fix_direct_push_failed", {
              workItemId: item.id,
              message: error instanceof Error ? error.message : String(error),
            });
            const latestAfterPushFailure = await getPullRequestBranchContext(
              env.installation.token,
              item.owner,
              item.repo,
              item.prNumber,
            );
            if (latestAfterPushFailure.headSha !== env.headSha) {
              await postFixReply(env.installation.token, { ...item, payload }, FIX_PUSH_STALE);
              return {};
            }
            const branch = fallbackBranchName(item.id, item.prNumber);
            const expectedSha = await getBranchHeadSha(
              env.installation.token,
              branchContext.baseOwner,
              branchContext.baseRepo,
              branch,
            );
            const baseRemoteUrl = `https://github.com/${branchContext.baseRepoFullName}.git`;
            await workspace.pushHeadToBranch(baseRemoteUrl, branch, {
              forceWithLeaseSha: expectedSha,
            });
            await recordFixPublishCheckpoint(pool, {
              workItemId: item.id,
              checkpoint: {
                kind: "fallbackBranch",
                headSha: publishedHeadSha(commits),
                branch,
                baseOwner: branchContext.baseOwner,
                baseRepo: branchContext.baseRepo,
                baseRef: branchContext.baseRef,
                replyState,
              },
            });
            const replacement = await createOrReuseFallbackPullRequest(env.installation.token, {
              owner: branchContext.baseOwner,
              repo: branchContext.baseRepo,
              headBranch: branch,
              baseBranch: branchContext.baseRef,
              title: `Auto-fix PR Agent findings for #${item.prNumber}`,
              body: fallbackPullRequestBody(item.id, item.prNumber),
            });
            const fallbackPr = { url: replacement.url, reused: replacement.reused };
            replyBody = renderAutoFixFinalReply({
              ...replyState,
              fallbackPr,
            });
            publishCheckpoint = {
              kind: "fallback",
              headSha: publishedHeadSha(commits),
              replyBody,
              replyPosted: false,
            };
            await recordFixPublishCheckpoint(pool, {
              workItemId: item.id,
              checkpoint: publishCheckpoint,
            });
          }
          await postFixReply(env.installation.token, { ...item, payload }, replyBody);
          await recordFixPublishCheckpoint(pool, {
            workItemId: item.id,
            checkpoint: { ...publishCheckpoint, replyPosted: true },
          });
          return {};
        }

        await postFixReply(
          env.installation.token,
          { ...item, payload },
          renderAutoFixFinalReply({
            commits,
            skipped,
            changedPaths: [],
          }),
        );
        return {};
      } finally {
        await workspace.cleanup();
      }
    },
  });
}
