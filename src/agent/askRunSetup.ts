import { logDebug } from "../evlog.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { buildAskGithubTools, createAskPathGate } from "./askSafety.js";
import { buildLocalWorkspaceTools } from "./localWorkspaceTools.js";
import { createRefreshableToolExecutors } from "./providers/cursor/refreshableGithubTools.js";
import type { AskRunParams } from "./askRun.js";

export function buildAskRunSetup(params: AskRunParams) {
  const { cfg, token, tokenExpiresAtTs, owner, repo, prNumber } = params;
  const pathGate = createAskPathGate();
  if (params.codeAnchor?.path) {
    pathGate.addPaths([params.codeAnchor.path]);
  }

  const refreshableGh = params.workspace
    ? {
        bundle: buildLocalWorkspaceTools(params.workspace),
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
