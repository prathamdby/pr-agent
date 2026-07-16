/** PR description agent block (merge-by-header). */
export const DESCRIPTION_AGENT_HEADER = "## PR Agent Description";
export const DESCRIPTION_BODY_SEPARATOR = "\n\n___\n\n";
export const DESCRIPTION_FAILURE_MESSAGE =
  "PR Agent could not generate a description for this pull request after retries. Try `/describe` again later.";
export const DESCRIPTION_ALREADY_IN_PROGRESS =
  "A `/describe` run is already queued or in progress for this pull request.";
export const DESCRIPTION_SUBMIT_ONLY_NUDGE =
  "You replied with text only. Call submitDescription now with a complete DescriptionPayload.";
export const DESCRIPTION_VALIDATION_REPAIR_ROUNDS = 3;
export const DESCRIPTION_PRE_SUBMIT_NUDGE_ROUNDS = 2;
export const MAX_DESCRIPTION_PAYLOAD_PR_FILES = 20;
