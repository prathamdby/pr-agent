/**
 * CI gate for the review summary / progress stub (not part of ReviewPayload).
 * Status/names are server facts; headline/reason/fixHint are LLM-authored when failing
 * (ADR 0018). Passing/pending/none use server templates.
 */

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
  /**
   * Optional install hint when Checks or Actions permission is missing.
   * Shown under the headline; review still publishes.
   */
  readonly permissionNote?: string;
};

export type CiCheckRunSnapshot = {
  readonly id: number;
  readonly name: string;
  /** Provider identity for durable PR Agent check-run recovery, when returned. */
  readonly externalId?: string | null;
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
