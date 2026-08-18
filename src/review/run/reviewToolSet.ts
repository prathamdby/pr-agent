import {
  CONTEXT7_TOOL_NAMES,
  WORKSPACE_READ_TOOL_NAMES,
} from "../../agent/tools/laneToolContract.js";
import { ORCHESTRATOR_PHASE_TOOLS } from "../orchestrator/phaseToolPolicy.js";

export const REVIEW_ORCHESTRATOR_TOOL_NAMES = [
  ...WORKSPACE_READ_TOOL_NAMES,
  ...CONTEXT7_TOOL_NAMES,
  ...ORCHESTRATOR_PHASE_TOOLS,
] as const;
