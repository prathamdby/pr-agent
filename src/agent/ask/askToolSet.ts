import { CONTEXT7_TOOL_NAMES, WORKSPACE_READ_TOOL_NAMES } from "../tools/laneToolContract.js";

export const ASK_TOOL_NAMES = [...WORKSPACE_READ_TOOL_NAMES, ...CONTEXT7_TOOL_NAMES] as const;
