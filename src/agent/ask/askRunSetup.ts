import { createAskPathGate } from "./askSafety.js";
import { buildLocalWorkspaceTools } from "../tools/localWorkspaceTools.js";
import type { AskRunParams } from "./askRunTypes.js";

export function buildAskRunSetup(params: AskRunParams) {
  const pathGate = createAskPathGate();
  const extraAllowedPaths = params.codeAnchor?.path ? [params.codeAnchor.path] : undefined;
  if (extraAllowedPaths) {
    pathGate.addPaths(extraAllowedPaths);
  }

  const refreshableGh = {
    bundle: buildLocalWorkspaceTools(params.workspace, {
      pathGate,
      extraAllowedPaths,
    }),
    refreshBeforeTool: async () => undefined,
  };

  return {
    refreshableGh,
    pathGate,
  };
}
