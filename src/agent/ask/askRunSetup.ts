import { createAskPathGate } from "./askSafety.ts";
import {
  buildWorkspaceTools,
  hideWorkspaceToolsBehindCodeMode,
} from "../runtime/durable/piTools.ts";
import type { AskRunParams } from "./askRunTypes.ts";

export function buildAskRunSetup(params: AskRunParams) {
  const pathGate = createAskPathGate();
  const extraAllowedPaths = params.codeAnchor?.path ? [params.codeAnchor.path] : undefined;

  const bundle = hideWorkspaceToolsBehindCodeMode(
    buildWorkspaceTools(params.workspace.reader, {
      pathGate,
      extraAllowedPaths,
    }),
  );
  return { bundle };
}
