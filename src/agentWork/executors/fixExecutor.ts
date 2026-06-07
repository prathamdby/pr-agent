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
  findLatestAutoFixTargetsByLens,
} from "../../autoFix/repository.js";
import { groupAutoFixTargets } from "../../autoFix/groupTargets.js";
import {
  createOrReuseFallbackPullRequest,
  getBranchHeadSha,
  getPullRequestBranchContext,
  getRepositoryPermission,
  permissionCanAutoFix,
} from "../../autoFix/github.js";
import { renderAutoFixFinalReply, type AutoFixSkippedTarget } from "../../autoFix/reply.js";
import { runAutoFixTargetGroup } from "../../autoFix/run.js";
import { prepareAutoFixWorkspace, type AutoFixCommit } from "../../autoFix/workspace.js";
import type { AutoFixTarget, AutoFixTargetGroup } from "../../autoFix/types.js";
import { getAppBotIdentity, postSlashReply } from "../githubPrSurface.js";
import { resolveWorkItemHeadSha, runDurableWorkItem } from "../durableJob.js";
import { findActiveFixConflict } from "../intake/workItemRepository.js";
import type { FixJobData, FixWorkPayload } from "../types.js";

const FIX_ALL_LENSES = ["review", "review-security", "review-quality"] as const;

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

function changedPathsFromCommits(commits: readonly AutoFixCommit[]): string[] {
  return [...new Set(commits.flatMap((commit) => commit.changedPaths))].toSorted();
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
  item: { resourceKey: string; payload: FixWorkPayload },
): Promise<AutoFixTarget[]> {
  const selector = item.payload.selector;
  if (selector.kind === "inline") {
    const target = await findAutoFixTargetByInlineComment(pool, {
      resourceKey: item.resourceKey,
      inlineReviewCommentId: selector.inlineReviewCommentId,
    });
    return target ? [target] : [];
  }
  return findLatestAutoFixTargetsByLens(pool, {
    resourceKey: item.resourceKey,
    lenses: FIX_ALL_LENSES,
  });
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
      const conflict = await findActiveFixConflict(pool, {
        resourceKey: item.resourceKey,
        selector: payload.selector,
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
      if (branchContext.headSha !== env.headSha) {
        await postFixReply(env.installation.token, { ...item, payload }, FIX_PUSH_STALE);
        return {};
      }

      const resolvedTargets = await resolveTargets(pool, {
        resourceKey: item.resourceKey,
        payload,
      });
      if (payload.selector.kind === "inline" && resolvedTargets.length === 0) {
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
          let fallbackPr: { url: string; reused: boolean } | undefined;
          try {
            await workspace.pushHeadToBranch(headRemoteUrl, branchContext.headRef);
          } catch (error) {
            logWarn("auto_fix_direct_push_failed", {
              workItemId: item.id,
              message: error instanceof Error ? error.message : String(error),
            });
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
            const replacement = await createOrReuseFallbackPullRequest(env.installation.token, {
              owner: branchContext.baseOwner,
              repo: branchContext.baseRepo,
              headBranch: branch,
              baseBranch: branchContext.baseRef,
              title: `Auto-fix PR Agent findings for #${item.prNumber}`,
              body: [
                `Auto-fix replacement for #${item.prNumber}.`,
                "",
                `Work item: ${item.id}`,
              ].join("\n"),
            });
            fallbackPr = { url: replacement.url, reused: replacement.reused };
          }

          await postFixReply(
            env.installation.token,
            { ...item, payload },
            renderAutoFixFinalReply({
              commits,
              fallbackPr,
              skipped,
              changedPaths: changedPathsFromCommits(commits),
            }),
          );
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
