/** Durable ask admission defaults. Refill values are seconds per token. */
export const DEFAULT_ASK_ACTOR_MAX_OUTSTANDING = 2;
export const DEFAULT_ASK_REPOSITORY_MAX_OUTSTANDING = 8;
export const DEFAULT_ASK_INSTALLATION_MAX_OUTSTANDING = 32;

export const DEFAULT_ASK_ACTOR_BURST = 3;
export const DEFAULT_ASK_REPOSITORY_BURST = 12;
export const DEFAULT_ASK_INSTALLATION_BURST = 48;

export const DEFAULT_ASK_ACTOR_REFILL_SECONDS = 60;
export const DEFAULT_ASK_REPOSITORY_REFILL_SECONDS = 10;
export const DEFAULT_ASK_INSTALLATION_REFILL_SECONDS = 1;

/** Zero disables the installation-wide provider token budget. */
export const DEFAULT_ASK_PROVIDER_BUDGET_TOKENS = 0;
export const DEFAULT_ASK_PROVIDER_BUDGET_WINDOW_SECONDS = 86_400;
/** Unknown provider usage consumes this reservation until the window resets. */
export const DEFAULT_ASK_PROVIDER_RESERVATION_TOKENS = 16_384;

export const ASK_THROTTLED_BODY = "This ask is temporarily throttled. Please try again later.";
