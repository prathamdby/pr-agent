/**
 * Required live installation-token holder for orchestrated-review GitHub writes (decision 27).
 * Mint callbacks still feed the holder inside {@link buildReviewWorkspaceTools}; callers only
 * read via this handle.
 */
export type InstallationTokenHandle = {
  readonly getToken: () => string;
  readonly getExpiresAtTs: () => number;
  readonly refreshNearExpiry: () => Promise<void>;
};
