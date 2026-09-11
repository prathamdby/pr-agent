/** Turn-level retries after a retryable assistant error with no admitted tool from that response. */
export const SESSION_TURN_RETRY_MAX = 1;

/** Base delay before the first turn retry. Doubles on each later retry. */
export const SESSION_TURN_RETRY_BASE_DELAY_MS = 250;

/** One compact-and-continue after a context-overflow assistant error. A second overflow is terminal. */
export const SESSION_OVERFLOW_COMPACT_MAX = 1;
