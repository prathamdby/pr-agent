import { createAskPathGate } from "./askSafety.js";
import { buildLocalWorkspaceTools } from "../tools/localWorkspaceTools.js";
import type { AskRunParams } from "./askRunTypes.js";

export function buildAskRunSetup(params: AskRunParams) {
  const pathGate = createAskPathGate();
  const extraAllowedPaths = params.codeAnchor?.path ? [params.codeAnchor.path] : undefined;
  if (extraAllowedPaths) {
    pathGate.addPaths(extraAllowedPaths);
  }

  const bundle = buildLocalWorkspaceTools(params.workspace, {
    pathGate,
    extraAllowedPaths,
  });

  return {
    bundle,
    pathGate,
  };
}
