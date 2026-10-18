import { createAskPathGate } from "./askSafety.ts";
import { hideWorkspaceToolsBehindCodeMode } from "../codemode/assembleExplorationTools.ts";
import { buildWorkspaceTools } from "../tools/workspaceToolset.ts";
import type { AskRunParams } from "./askRunTypes.ts";

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
