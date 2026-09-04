import {
  REVIEW_CI_SUMMARY_LOG_MAX_BYTES,
  REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
} from "../../settings/index.js";
import { redactReviewText } from "../findings/reviewPublicOutput.js";
import { boundRawLogIntake, isDeprecationNoiseLine, lineHasCiErrorSignal } from "./rawLogIntake.js";

export { boundRawLogIntake, isDeprecationNoiseLine, rawLogIntakeCap } from "./rawLogIntake.js";

export type CondensedJobLog = {
  readonly name: string;
  readonly url?: string;
  readonly text: string;
};

export type CondenseCiLogsOptions = {
  readonly maxBytes?: number;
  readonly perJobMaxChars?: number;
};

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Keeps failed-step tails and error lines; drops Node/Actions deprecation noise unless
 * it is the only remaining signal.
 */
export function condenseJobLogText(
  raw: string,
  maxChars: number = REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
): string {
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
  return redactReviewText(condensed);
}

function pushKeptLine(kept: string[], keptChars: number, line: string, maxChars: number): number {
  if (kept.includes(line)) return keptChars;
  kept.push(line);
  let nextChars = keptChars + line.length + (keptChars > 0 ? 1 : 0);
  while (kept.length > 1 && nextChars > maxChars) {
    const dropped = kept.shift();
    if (dropped == null) break;
    nextChars -= dropped.length + 1;
  }
  return nextChars;
}

/**
 * Merges per-job condensed logs under a global byte budget. Earlier (first failing) jobs win.
 */
export function mergeCondensedJobLogs(
  jobs: readonly CondensedJobLog[],
  options: CondenseCiLogsOptions = {},
): string {
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

  return redactReviewText(parts.join("\n\n"));
}

/**
 * Caps an already-condensed context to the global CI-summary byte budget.
 * Keeps the tail, matching per-job char truncation (failures usually land last).
 */
export function boundCondensedLogBytes(
  text: string,
  maxBytes: number = REVIEW_CI_SUMMARY_LOG_MAX_BYTES,
): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const buf = Buffer.from(trimmed, "utf8");
  const bounded =
    buf.byteLength <= maxBytes ? trimmed : buf.subarray(buf.byteLength - maxBytes).toString("utf8");
  return redactReviewText(bounded);
}

/**
 * Picks one redacted, size-bounded CI context: Actions job logs win; otherwise
 * condensed check output; otherwise empty. Author/prompt must not see a second raw field.
 */
export function selectEffectiveCiContext(params: {
  readonly jobs: readonly CondensedJobLog[];
  readonly checkOutput?: string;
  readonly maxBytes?: number;
  readonly perJobMaxChars?: number;
}): string {
  const jobs = params.jobs.filter((job) => job.text.trim().length > 0);
  if (jobs.length > 0) {
    return mergeCondensedJobLogs(jobs, { maxBytes: params.maxBytes });
  }
  const checkOutput = params.checkOutput?.trim() ?? "";
  if (checkOutput.length === 0) return "";
  const condensed = condenseJobLogText(checkOutput, params.perJobMaxChars);
  if (condensed.trim().length === 0) return "";
  return boundCondensedLogBytes(condensed, params.maxBytes);
}
