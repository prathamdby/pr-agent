/** Verification agent caps. */
export const MAX_TOOL_ROUNDS_VERIFICATION = 32;

/**
 * Escalated verification attempts re-check only the oldest slice of the open
 * finding inventory; the remainder waits for a later attempt or a fresh run.
 */
export const MAX_ESCALATED_VERIFICATION_INVENTORY = 10;

/** HTML markers for the one in-place terminal-failure signal. */
export const VERIFICATION_FAILURE_START = "<!-- pr-agent:verification-failure -->";
export const VERIFICATION_FAILURE_END = "<!-- /pr-agent:verification-failure -->";

/** Visible failure copy. Retry command only. No diagnostics. */
export const VERIFICATION_FAILURE_TEXT =
  "Verification did not complete. Run `/verify` to try again.";
