import { AsyncLocalStorage } from "node:async_hooks";
import { logInfo, logWarn } from "../evlog.js";
import { recordReviewMetric } from "../review/run/reviewRunMetrics.js";

export const RATE_LIMIT_CIRCUIT_THRESHOLD = 3;

export type RateLimitFailureClass = "primary" | "secondary";

export type RateLimitCircuit = {
  readonly installationId: number;
  readonly recordSuccess: () => void;
  readonly recordFailure: (kind: RateLimitFailureClass) => boolean;
  readonly isOpen: () => boolean;
  readonly consecutiveFailures: () => number;
  /** Open from shared DB state without firing onOpened. */
  readonly hydrateOpenFromShared: (kind?: RateLimitFailureClass) => void;
};

const circuitStore = new AsyncLocalStorage<RateLimitCircuit>();

export const CIRCUIT_OPEN_TOOL_RESULT =
  "Rate-limit circuit open: further nonessential GitHub tools are blocked for this run. Prefer publish/submit tools with evidence already gathered.";

/** Tools that must keep working after the circuit opens (publish / submit paths). */
export const ESSENTIAL_GITHUB_TOOL_NAMES: ReadonlySet<string> = new Set([
  "submitReview",
  "publish_thread",
  "publish_summary",
  "submit_specialist_brief",
  "submitSpecialistReport",
  "submit_specialist_report",
  "submitVerification",
  "submitTriage",
  "submitDescription",
]);

/**
 * Tools that call GitHub REST/GraphQL (vs local workspace). Nonessential members are
 * short-circuited when the per-run circuit is open.
 */
export const GITHUB_API_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...ESSENTIAL_GITHUB_TOOL_NAMES,
  "getPullRequest",
  "listPullRequests",
  "listPullRequestFiles",
  "listPullRequestReviews",
  "getFileContent",
  "listCommits",
  "getCommit",
  "getBlame",
  "getRepository",
  "listBranches",
  "searchCode",
]);

export function createRateLimitCircuit(params: {
  readonly installationId: number;
  readonly threshold?: number;
  readonly onOpened?: (kind: RateLimitFailureClass) => void;
}): RateLimitCircuit {
  const threshold = params.threshold ?? RATE_LIMIT_CIRCUIT_THRESHOLD;
  let consecutive = 0;
  let open = false;

  return {
    installationId: params.installationId,
    consecutiveFailures: () => consecutive,
    isOpen: () => open,
    recordSuccess: () => {
      consecutive = 0;
    },
    recordFailure: (kind) => {
      if (open) return false;
      consecutive += 1;
      if (consecutive < threshold) return false;
      open = true;
      params.onOpened?.(kind);
      return true;
    },
    hydrateOpenFromShared: (_kind) => {
      if (open) return;
      open = true;
      consecutive = threshold;
    },
  };
}

export function runWithRateLimitCircuit<T>(circuit: RateLimitCircuit, fn: () => T): T {
  return circuitStore.run(circuit, fn);
}

export function getActiveRateLimitCircuit(): RateLimitCircuit | undefined {
  return circuitStore.getStore();
}

export function noteRateLimitRetryExhausted(kind: RateLimitFailureClass): void {
  const circuit = getActiveRateLimitCircuit();
  if (!circuit) return;
  const opened = circuit.recordFailure(kind);
  if (!opened) return;
  logWarn("github_rate_limit_circuit_opened", {
    installationId: circuit.installationId,
    kind,
    threshold: RATE_LIMIT_CIRCUIT_THRESHOLD,
  });
  logInfo("github_rate_limit_circuit_opened", {
    installationId: circuit.installationId,
    kind,
  });
  recordReviewMetric({ kind: "rate_limit_circuit_opened" });
}

export function noteGithubRequestSuccess(): void {
  getActiveRateLimitCircuit()?.recordSuccess();
}

export function shouldShortCircuitGithubTool(toolName: string): boolean {
  const circuit = getActiveRateLimitCircuit();
  if (!circuit?.isOpen()) return false;
  if (!GITHUB_API_TOOL_NAMES.has(toolName)) return false;
  if (ESSENTIAL_GITHUB_TOOL_NAMES.has(toolName)) return false;
  return true;
}

export function wrapExecutorsWithRateLimitCircuit(
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const wrapped: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    ...executors,
  };
  for (const [name, executor] of Object.entries(executors)) {
    wrapped[name] = async (args) => {
      if (shouldShortCircuitGithubTool(name)) {
        logWarn("github_tool_circuit_short_circuit", { tool: name });
        return { error: true, message: CIRCUIT_OPEN_TOOL_RESULT };
      }
      return executor(args);
    };
  }
  return wrapped;
}
