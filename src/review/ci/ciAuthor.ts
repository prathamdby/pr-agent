import { CI_SUMMARY_SYSTEM_PROMPT, buildCiContextUserMessage } from "../../prompts/ci/prompt.ts";
import * as v from "valibot";
import {
  type Config,
  REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS,
  REVIEW_CI_SUMMARY_GRANT_ACTIONS,
  REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS,
  REVIEW_CI_SUMMARY_LOG_MAX_BYTES,
  REVIEW_CI_SUMMARY_LOG_MAX_JOBS,
  REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
  REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE,
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_REASON_MAX_CHARS,
} from "../../settings/index.ts";
import { createFeaturePiSession } from "../../agent/runtime/createFeatureSession.ts";
import { AppError } from "../../errors/appError.ts";
import { parseEmbeddedJsonObject } from "../parseEmbeddedJsonObject.ts";
import { logDebug, logWarn } from "../../evlog.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import { redactReviewText } from "../findings/reviewPublicOutput.ts";
import {
  isCheckFactFailing,
  type CiCheckFact,
  type CiFailureDetail,
  type CiSummary,
  type CiSummaryStatus,
} from "./ciFacts.ts";
import { errorMessage } from "../../errors/errorMessage.ts";

export const ciSummaryLlmSchema = v.object({
  headline: v.pipe(v.string(), v.minLength(1), v.maxLength(REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS)),
  failures: v.pipe(
    v.array(
      v.object({
        name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        reason: v.pipe(v.string(), v.minLength(1), v.maxLength(REVIEW_CI_SUMMARY_REASON_MAX_CHARS)),
        fixHint: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS),
        ),
      }),
    ),
    v.maxLength(REVIEW_CI_SUMMARY_MAX_FAILURES),
  ),
});
export type CiSummaryLlmFields = v.InferOutput<typeof ciSummaryLlmSchema>;

export const DEPRECATION_NOISE_RE =
  /\b(Node\.js\s*20\s+is\s+deprecated|actions\/[\w-]+@[\w./-]+\s+.*Node\.js|The following actions target Node\.js|Node\.js\s+\d+\s+actions?\s+are\s+deprecated)\b/i;

export const ERROR_SIGNAL_RE =
  /\b(error|failed|failure|FAIL|AssertionError|TypeError|ENOENT|ELIFECYCLE|✖|✗|×|format issues|Process completed with exit code [1-9])\b/i;

export const FAILED_STEP_MARKERS = [
  /^##\[error\]/i,
  /^##\[group\].*(fail|error)/i,
  /Process completed with exit code [1-9]/i,
  /^Error:/i,
  /Format issues found/i,
  /\d+\s+failed/i,
];

export function isDeprecationNoiseLine(line: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(DEPRECATION_NOISE_RE.test(line));
}

export function lineHasCiErrorSignal(line: string) {
  if (isDeprecationNoiseLine(line)) {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(
    FAILED_STEP_MARKERS.some((re) => re.test(line)) || ERROR_SIGNAL_RE.test(line),
  );
}

export function rawLogIntakeCap(perJobMaxChars: number = REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS) {
  return ((pinnedReturn: number) => pinnedReturn)(
    perJobMaxChars * REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE,
  );
}

function lastCiErrorLineRange(raw: string) {
  let end = raw.length;
  while (end > 0) {
    const newline = raw.lastIndexOf("\n", end - 1);
    const start = newline + 1;
    if (lineHasCiErrorSignal(raw.slice(start, end))) {
      return ((pinnedReturn: { start: number; end: number } | null) => pinnedReturn)({
        start,
        end: end < raw.length ? end + 1 : end,
      });
    }
    if (newline < 0) {
      break;
    }
    end = newline;
  }
  return ((pinnedReturn: { start: number; end: number } | null) => pinnedReturn)(null);
}

function textHasCiErrorSignal(text: string) {
  if (text.length === 0) {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  let from = 0;
  while (from < text.length) {
    const newline = text.indexOf("\n", from);
    const end = newline === -1 ? text.length : newline;
    if (lineHasCiErrorSignal(text.slice(from, end))) {
      return ((pinnedReturn: boolean) => pinnedReturn)(true);
    }
    if (newline === -1) {
      break;
    }
    from = newline + 1;
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(false);
}

export function boundRawLogIntake(
  raw: string,
  perJobMaxChars: number = REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
) {
  const cap = rawLogIntakeCap(perJobMaxChars);
  if (raw.length <= cap) {
    return ((pinnedReturn: string) => pinnedReturn)(raw);
  }

  const tail = raw.slice(raw.length - cap);
  if (textHasCiErrorSignal(tail)) {
    return ((pinnedReturn: string) => pinnedReturn)(tail);
  }

  const error = lastCiErrorLineRange(raw);
  if (error == null) {
    return ((pinnedReturn: string) => pinnedReturn)(tail);
  }

  const start = Math.max(0, error.end - cap);
  return ((pinnedReturn: string) => pinnedReturn)(raw.slice(start, start + cap));
}

export type CondensedJobLog = {
  readonly name: string;
  readonly url?: string;
  readonly text: string;
};

export type CondenseCiLogsOptions = {
  readonly maxBytes?: number;
  readonly perJobMaxChars?: number;
};

function collapseBlankLines(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(text.replace(/\n{3,}/g, "\n\n").trim());
}

export function condenseJobLogText(
  raw: string,
  maxChars: number = REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
) {
  const intake = boundRawLogIntake(raw, maxChars);
  const lines = intake.split(/\r?\n/);
  const kept: string[] = [];
  let sawRealError = false;
  let keptChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (lineHasCiErrorSignal(line)) {
      sawRealError = true;
      const start = Math.max(0, i - 2);
      for (let j = start; j <= i; j++) {
        const candidate = lines[j] ?? "";
        if (isDeprecationNoiseLine(candidate)) continue;
        keptChars = pushKeptLine(kept, keptChars, candidate, maxChars);
      }
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const candidate = lines[j] ?? "";
        if (isDeprecationNoiseLine(candidate)) continue;
        keptChars = pushKeptLine(kept, keptChars, candidate, maxChars);
      }
    }
  }

  let condensed: string;
  if (kept.length > 0) {
    condensed = collapseBlankLines(kept.join("\n"));
  } else if (!sawRealError) {
    const tail = lines
      .filter((line) => line.trim().length > 0)
      .slice(-40)
      .filter((line) => !isDeprecationNoiseLine(line));
    condensed =
      tail.length > 0
        ? collapseBlankLines(tail.join("\n"))
        : collapseBlankLines(
            lines
              .filter((line) => line.trim().length > 0)
              .slice(-20)
              .join("\n"),
          );
  } else {
    condensed = "";
  }

  if (condensed.length > maxChars) {
    condensed = condensed.slice(condensed.length - maxChars);
  }
  return ((pinnedReturn: string) => pinnedReturn)(redactReviewText(condensed));
}

function pushKeptLine(kept: string[], keptChars: number, line: string, maxChars: number) {
  if (kept.includes(line)) return ((pinnedReturn: number) => pinnedReturn)(keptChars);
  kept.push(line);
  let nextChars = keptChars + line.length + (keptChars > 0 ? 1 : 0);
  while (kept.length > 1 && nextChars > maxChars) {
    const dropped = kept.shift();
    if (dropped == null) break;
    nextChars -= dropped.length + 1;
  }
  return ((pinnedReturn: number) => pinnedReturn)(nextChars);
}

export function mergeCondensedJobLogs(
  jobs: readonly CondensedJobLog[],
  options: CondenseCiLogsOptions = {},
) {
  const maxBytes = options.maxBytes ?? REVIEW_CI_SUMMARY_LOG_MAX_BYTES;
  const parts: string[] = [];
  let used = 0;

  for (const job of jobs) {
    const header = `### Job: ${job.name}${job.url != null ? ` (${job.url})` : ""}`;
    const block = `${header}\n${job.text}`.trim();
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (used + blockBytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - used - Buffer.byteLength(header, "utf8") - 1);
      if (remaining < 64) break;
      const truncated = job.text.slice(0, remaining);
      parts.push(`${header}\n${truncated}`);
      break;
    }
    parts.push(block);
    used += blockBytes + 2;
  }

  return ((pinnedReturn: string) => pinnedReturn)(redactReviewText(parts.join("\n\n")));
}

export function boundCondensedLogBytes(
  text: string,
  maxBytes: number = REVIEW_CI_SUMMARY_LOG_MAX_BYTES,
) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return ((pinnedReturn: string) => pinnedReturn)("");
  const buf = Buffer.from(trimmed, "utf8");
  const bounded =
    buf.byteLength <= maxBytes ? trimmed : buf.subarray(buf.byteLength - maxBytes).toString("utf8");
  return ((pinnedReturn: string) => pinnedReturn)(redactReviewText(bounded));
}

export function selectEffectiveCiContext(params: {
  readonly jobs: readonly CondensedJobLog[];
  readonly checkOutput?: string;
  readonly maxBytes?: number;
  readonly perJobMaxChars?: number;
}) {
  const jobs = params.jobs.filter((job) => job.text.trim().length > 0);
  if (jobs.length > 0) {
    return ((pinnedReturn: string) => pinnedReturn)(
      mergeCondensedJobLogs(jobs, { maxBytes: params.maxBytes }),
    );
  }
  const checkOutput = params.checkOutput?.trim() ?? "";
  if (checkOutput.length === 0) return ((pinnedReturn: string) => pinnedReturn)("");
  const condensed = condenseJobLogText(checkOutput, params.perJobMaxChars);
  if (condensed.trim().length === 0) return ((pinnedReturn: string) => pinnedReturn)("");
  return ((pinnedReturn: string) => pinnedReturn)(
    boundCondensedLogBytes(condensed, params.maxBytes),
  );
}

export type CiAuthorInput = {
  readonly status: Extract<CiSummaryStatus, "passing" | "failing" | "pending" | "none">;
  readonly checkNames: readonly string[];
  readonly failingNames: readonly string[];
  readonly failingUrls: ReadonlyMap<string, string | undefined>;
  readonly condensedLogs: string;
};

export type CiSummaryAuthor = (input: CiAuthorInput) => Promise<CiSummaryLlmFields | null>;

function extractJsonObject(text: string) {
  const value = parseEmbeddedJsonObject(text);
  if (value === undefined) {
    throw new AppError({
      domain: "ci",
      kind: "summary_no_json",
      message: "CI summary LLM response contained no JSON object",
    });
  }
  return ((pinnedReturn: unknown) => pinnedReturn)(value);
}

export function parseCiSummaryLlmText(text: string) {
  const parsed = extractJsonObject(text);
  return ((pinnedReturn: CiSummaryLlmFields) => pinnedReturn)(v.parse(ciSummaryLlmSchema, parsed));
}

export function mergeCiSummaryWithFacts(input: CiAuthorInput, llm: CiSummaryLlmFields) {
  const byName = new Map(llm.failures.map((f) => [f.name.toLowerCase(), f]));
  const failures: CiFailureDetail[] = [];

  if (input.status === "failing") {
    for (const name of input.failingNames) {
      const match = byName.get(name.toLowerCase());
      const reason = redactReviewText(
        match?.reason ?? "Check failed; see the linked job logs for details.",
      );
      const fixHint = redactReviewText(
        match?.fixHint ?? `Inspect the failing “${name}” check, fix the error, and re-push.`,
      );
      failures.push({
        name,
        reason,
        fixHint,
        url: input.failingUrls.get(name),
      });
    }
  }

  const headline =
    input.status === "passing"
      ? "✅ All CI is passing"
      : input.status === "pending"
        ? "⏳ CI still running"
        : input.status === "none"
          ? "No CI checks on this head"
          : redactReviewText(llm.headline);

  return ((pinnedReturn: CiSummary) => pinnedReturn)({
    status: input.status,
    headline,
    failures,
  });
}

export function createAgentCiSummaryAuthor(
  cfg: Config,
  createSession: typeof createFeaturePiSession = createFeaturePiSession,
) {
  return ((pinnedReturn: CiSummaryAuthor) => pinnedReturn)(async (input) => {
    if (input.status !== "failing") {
      return {
        headline:
          input.status === "passing"
            ? "✅ All CI is passing"
            : input.status === "pending"
              ? "⏳ CI still running"
              : "No CI checks on this head",
        failures: [],
      };
    }

    const session = await createSession({
      role: "ci_summary",
      cfg,
      systemPrompt: CI_SUMMARY_SYSTEM_PROMPT,
      tools: [],
      executors: {},
    });
    try {
      const prompt = buildCiContextUserMessage(input);
      const turn = await session.send(prompt, {
        maxToolRounds: 0,
        phase: "ci_summary",
        checkpointId: "ci_summary:ci_summary",
      });
      const fields = parseCiSummaryLlmText(turn.text);
      logDebug("review_ci_summary_authored", {
        failureCount: fields.failures.length,
        headlineChars: fields.headline.length,
      });
      return fields;
    } catch (error) {
      logWarn("review_ci_summary_author_failed", {
        message: errorMessage(error),
      });
      return null;
    } finally {
      await session.dispose();
    }
  });
}

export function factsOnlyFailingSummary(input: CiAuthorInput) {
  const nameList = input.failingNames.slice(0, 3).join(", ");
  const more = input.failingNames.length > 3 ? ` (+${input.failingNames.length - 3} more)` : "";
  return ((pinnedReturn: CiSummary) => pinnedReturn)({
    status: "failing",
    headline: `❌ CI failing — ${nameList}${more}`,
    failures: input.failingNames.map((name) => ({
      name,
      reason: "Check failed; CI log summary was unavailable.",
      fixHint: `Inspect the failing “${name}” check, fix the error, and re-push.`,
      url: input.failingUrls.get(name),
    })),
  });
}

export type CiAuthorContext = {
  readonly condensedLogs: string;
  readonly permissionNote?: string;
};

export function ciAuthorInputFromFacts(
  checks: Readonly<Record<string, CiCheckFact>>,
  condensedLogs: string,
) {
  const facts = Object.values(checks);
  const failing = facts.filter(isCheckFactFailing);
  return ((pinnedReturn: CiAuthorInput) => pinnedReturn)({
    status: "failing",
    checkNames: facts.map((fact) => fact.name),
    failingNames: failing.map((fact) => fact.name),
    failingUrls: new Map(failing.map((fact) => [fact.name, fact.url ?? undefined])),
    condensedLogs,
  });
}

export async function fetchCiAuthorContext(params: {
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly checks: Readonly<Record<string, CiCheckFact>>;
}) {
  const failing = Object.values(params.checks).filter(isCheckFactFailing);
  const jobs: CondensedJobLog[] = [];
  let actionsPermissionMissing = false;

  const byCheckRunId = failing.filter((fact) => fact.check_run_id != null);
  for (const fact of byCheckRunId.slice(0, REVIEW_CI_SUMMARY_LOG_MAX_JOBS)) {
    const downloaded = await params.prSurface.downloadActionsJobLogs(fact.check_run_id ?? 0);
    if (!downloaded.ok && downloaded.reason === "actions_permission") {
      actionsPermissionMissing = true;
      break;
    }
    if (!downloaded.ok) continue;
    jobs.push({
      name: fact.name,
      ...(fact.url != null ? { url: fact.url } : {}),
      text: condenseJobLogText(downloaded.text),
    });
  }

  if (jobs.length === 0 && !actionsPermissionMissing) {
    const listed = await params.prSurface.listFailingActionsJobs(params.headSha);
    if (!listed.ok) {
      actionsPermissionMissing = listed.reason === "actions_permission";
    } else {
      for (const job of listed.jobs.slice(0, REVIEW_CI_SUMMARY_LOG_MAX_JOBS)) {
        const downloaded = await params.prSurface.downloadActionsJobLogs(job.id);
        if (!downloaded.ok && downloaded.reason === "actions_permission") {
          actionsPermissionMissing = true;
          break;
        }
        if (!downloaded.ok) continue;
        jobs.push({
          name: job.name,
          ...(job.htmlUrl != null ? { url: job.htmlUrl } : {}),
          text: condenseJobLogText(downloaded.text),
        });
      }
    }
  }

  return ((pinnedReturn: CiAuthorContext | Promise<CiAuthorContext>) => pinnedReturn)({
    condensedLogs: selectEffectiveCiContext({ jobs }),
    ...(actionsPermissionMissing ? { permissionNote: REVIEW_CI_SUMMARY_GRANT_ACTIONS } : {}),
  });
}
