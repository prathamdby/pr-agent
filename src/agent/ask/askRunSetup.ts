import { createAskPathGate } from "./askSafety.js";
import { buildCodeIndexTools, buildUnavailableCodeIndexTools } from "../tools/codeIndexTools.js";
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
  );
  const codeIndex =
    params.pool && params.codeIndexSnapshotId
      ? buildCodeIndexTools({
          pool: params.pool,
          snapshotId: params.codeIndexSnapshotId,
          workspace: params.workspace,
          pathGate,
        })
      : buildUnavailableCodeIndexTools();

  return {
    bundle: {
      piTools: [...bundle.piTools, ...codeIndex.piTools],
      executors: { ...bundle.executors, ...codeIndex.executors },
    },
  };
}
