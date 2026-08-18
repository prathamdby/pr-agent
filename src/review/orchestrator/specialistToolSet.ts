import {
  CONTEXT7_TOOL_NAMES,
  WORKSPACE_READ_TOOL_NAMES,
} from "../../agent/tools/laneToolContract.js";

export const REVIEW_SPECIALIST_TOOL_NAMES = [
  ...WORKSPACE_READ_TOOL_NAMES,
  ...CONTEXT7_TOOL_NAMES,
  "submit_findings_report",
] as const;
