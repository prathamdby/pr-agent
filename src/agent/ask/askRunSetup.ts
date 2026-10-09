import { createAskPathGate } from "./askSafety.js";
import { hideWorkspaceToolsBehindCodeMode } from "../codemode/assembleExplorationTools.js";
import { buildWorkspaceTools } from "../tools/workspaceToolset.js";
import type { AskRunParams } from "./askRunTypes.js";

export function buildAskRunSetup(params: AskRunParams) {
  const pathGate = createAskPathGate();
  const extraAllowedPaths = params.codeAnchor?.path ? [params.codeAnchor.path] : undefined;

  const bundle = hideWorkspaceToolsBehindCodeMode(
    buildWorkspaceTools(params.workspace.reader, {
      pathGate,
      extraAllowedPaths,
    }),
    { executorKind: params.cfg.codeMode.executorKind },
  );
  return { bundle };
}
