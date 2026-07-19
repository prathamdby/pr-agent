/** Server-derived CI gate for the review summary / progress stub (not part of ReviewPayload). */

export type CiSummaryStatus = "passing" | "failing" | "pending" | "none" | "unavailable";

export type CiFailureDetail = {
  /** Check run or status context name. */
  readonly name: string;
  /** One-line root cause when known. */
  readonly reason: string;
  /** Short fix direction for humans and coding agents. */
  readonly fixHint: string;
  /** Optional deep-link to the failing check run. */
  readonly url?: string;
};

export type CiSummary = {
  readonly status: CiSummaryStatus;
  /** Short lead for the CI table cell. */
  readonly headline: string;
  /** Failure digests (empty unless status is failing). */
  readonly failures: readonly CiFailureDetail[];
};

export type CiCheckRunSnapshot = {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string | null;
  readonly outputTitle: string | null;
  readonly outputSummary: string | null;
  readonly outputText: string | null;
};

export type CiCheckAnnotation = {
  readonly path: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly title: string | null;
  readonly message: string;
  readonly annotationLevel: string;
};

export type CiLegacyStatus = {
  readonly context: string;
  readonly state: string;
  readonly description: string | null;
  readonly targetUrl: string | null;
};
