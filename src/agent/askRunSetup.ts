import { isLevelEnabled, logDebug } from "../evlog.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { buildAskGithubTools, createAskPathGate } from "./askSafety.js";
import { buildLocalWorkspaceTools, workspaceToolLimitsFromConfig } from "./localWorkspaceTools.js";
import { createRefreshableToolExecutors } from "./providers/cursor/refreshableGithubTools.js";
import type { AskRunParams } from "./askRunTypes.js";

export function buildAskRunSetup(params: AskRunParams) {
  const { cfg, token, tokenExpiresAtTs, owner, repo, prNumber } = params;
  const pathGate = createAskPathGate();
  const extraAllowedPaths = params.codeAnchor?.path ? [params.codeAnchor.path] : undefined;
  if (extraAllowedPaths) {
    pathGate.addPaths(extraAllowedPaths);
  }

  const refreshableGh = params.workspace
    ? {
        bundle: buildLocalWorkspaceTools(params.workspace, workspaceToolLimitsFromConfig(cfg), {
          pathGate,
          extraAllowedPaths,
        }),
        refreshBeforeTool: async () => undefined,
      }
    : createRefreshableToolExecutors({
        initialToken: token,
        tokenExpiresAtTs,
        refreshInstallationToken: params.refreshInstallationToken,
        build: (activeToken) => {
          const gh = buildAskGithubTools(
            activeToken,
            { owner, repo, prNumber, headSha: params.headSha },
            {
              maxPrFilesListed: cfg.maxPrFilesListed,
              maxPrFilesPatchBytes: cfg.maxPrFilesPatchBytes,
            },
            pathGate,
          );
          return { piTools: gh.piTools, executors: gh.executors };
        },
      });

  return {
    refreshableGh,
    pathGate,
    primePathGate: async () => {
      if (params.workspace) return;
      try {
        await refreshableGh.bundle.executors.listPullRequestFiles?.({});
      } catch (e) {
        if (!isLevelEnabled("debug")) return;
        logDebug("ask_path_gate_prime_failed", {
          owner,
          repo,
          pr: prNumber,
          message: sanitizeLogMessage(e instanceof Error ? e.message : String(e)),
        });
      }
    },
  };
}
