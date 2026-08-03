/** PR description agent block boundaries (merge-by-marker). */
export const DESCRIPTION_AGENT_BODY_BEGIN = "<!-- PR_AGENT_DESCRIPTION_BEGIN -->";
export const DESCRIPTION_AGENT_BODY_END = "<!-- PR_AGENT_DESCRIPTION_END -->";
export const DESCRIPTION_AGENT_HEADER = "## PR Agent Description";
export const DESCRIPTION_FAILURE_MESSAGE =
  "PR Agent could not generate a description for this pull request after retries. Try `/describe` again later.";
export const DESCRIPTION_ALREADY_IN_PROGRESS =
  "A `/describe` run is already queued or in progress for this pull request.";
export const DESCRIPTION_SUBMIT_ONLY_NUDGE =
  "You replied with text only. Call submitDescription now with a complete DescriptionPayload.";
export const DESCRIPTION_VALIDATION_REPAIR_ROUNDS = 3;
export const DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS = 2;

export const DESCRIPTION_MAP_OMIT_MAX_FILES = 5;
export const DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES = 300;
export const DESCRIPTION_MAP_MAX_ENTRIES = 5;
/** Schema ceiling above publish cap so enforce can cap-and-publish. */
export const MAX_DESCRIPTION_PAYLOAD_PR_FILES = 20;
export const DESCRIPTION_REVIEW_MAP_HEADING = "### Review map";

export const MAX_TOOL_ROUNDS_DESCRIBE = 16;
