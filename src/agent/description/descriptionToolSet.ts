import { WORKSPACE_READ_TOOL_NAMES } from "../tools/laneToolContract.js";

export const DESCRIPTION_TOOL_NAMES = [...WORKSPACE_READ_TOOL_NAMES, "submitDescription"] as const;
