import { isLevelEnabled, logDebug } from "../../evlog.js";
import { sanitizeLogMessage } from "../../security/sanitizeLogMessage.js";
import { createAskPathGate } from "./askSafety.js";
import {
  buildLocalWorkspaceTools,
  workspaceToolLimitsFromConfig,
} from "../tools/localWorkspaceTools.js";
import type { AskRunParams } from "./askRunTypes.js";

export function buildAskRunSetup(params: AskRunParams) {
  const { cfg, owner, repo, prNumber } = params;
  const pathGate = createAskPathGate();
  const extraAllowedPaths = params.codeAnchor?.path ? [params.codeAnchor.path] : undefined;
  if (extraAllowedPaths) {
    pathGate.addPaths(extraAllowedPaths);
  }

  const refreshableGh = {
    bundle: buildLocalWorkspaceTools(params.workspace, workspaceToolLimitsFromConfig(cfg), {
      pathGate,
      extraAllowedPaths,
    }),
    refreshBeforeTool: async () => undefined,
  };

  return {
    refreshableGh,
    pathGate,
    primePathGate: async () => {
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
