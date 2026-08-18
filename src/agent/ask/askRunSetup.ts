import { createAskPathGate } from "./askSafety.js";
import { buildContext7Tools } from "../tools/context7Tools.js";
import { assembleNamedTools } from "../tools/laneToolContract.js";
import { ASK_TOOL_NAMES } from "./askToolSet.js";
import { buildLocalWorkspaceTools } from "../tools/localWorkspaceTools.js";
import { CONTEXT7_RESPONSE_BYTES } from "../../settings/index.js";
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
  const ctx7 = buildContext7Tools({
    apiKey: params.cfg.context7ApiKey,
    maxResponseBytes: CONTEXT7_RESPONSE_BYTES,
  });
  const assembled = assembleNamedTools(ASK_TOOL_NAMES, [
    {
      piTools: [...bundle.piTools, ...ctx7.piTools],
      executors: { ...bundle.executors, ...ctx7.executors },
    },
  ]);

  return {
    bundle: assembled,
    pathGate,
  };
}
