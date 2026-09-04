/** Verification agent caps. */
export const MAX_TOOL_ROUNDS_VERIFICATION = 32;

/** HTML markers for the one in-place terminal-failure signal. */
export const VERIFICATION_FAILURE_START = "<!-- pr-agent:verification-failure -->";
export const VERIFICATION_FAILURE_END = "<!-- /pr-agent:verification-failure -->";

/** Visible failure copy. Retry command only. No diagnostics. */
export const VERIFICATION_FAILURE_TEXT =
  "Verification did not complete. Run `/verify` to try again.";
