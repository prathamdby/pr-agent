import { formatLaneToolContract } from "../tools/laneToolContract.js";
import { REVIEW_SPECIALIST_TOOL_NAMES } from "../../review/orchestrator/specialistToolSet.js";

export const githubToolingDiscipline = [
  "## Investigation protocol",
  formatLaneToolContract(REVIEW_SPECIALIST_TOOL_NAMES),
  "Follow each tool's description for investigation order, literal search, and truncation. The workspace is a full checkout of the PR head.",
  "- Anchor every finding to the changed line that best supports it. For a cross-file issue, use the changed line that most directly exposes the problem.",
  "- Report only issues introduced or exposed by this PR; never file unrelated pre-existing issues.",
  "- If a tool refuses for path, size, or workspace reasons, work from what you have, note the limit, and continue from other evidence.",
].join("\n");
