import {
  REVIEW_CI_SUMMARY_LOG_MAX_BYTES,
  REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
} from "../../settings/index.js";
import { redactReviewText } from "../findings/reviewPublicOutput.js";

/** Runner / toolchain noise that must not beat a real test/lint/build failure. */
const DEPRECATION_NOISE_RE =
  /\b(Node\.js\s*20\s+is\s+deprecated|actions\/[\w-]+@[\w./-]+\s+.*Node\.js|The following actions target Node\.js|Node\.js\s+\d+\s+actions?\s+are\s+deprecated)\b/i;

const ERROR_SIGNAL_RE =
  /\b(error|failed|failure|FAIL|AssertionError|TypeError|ENOENT|ELIFECYCLE|✖|✗|×|format issues|Process completed with exit code [1-9])\b/i;

const FAILED_STEP_MARKERS = [
  /^##\[error\]/i,
  /^##\[group\].*(fail|error)/i,
  /Process completed with exit code [1-9]/i,
  /^Error:/i,
  /Format issues found/i,
  /\d+\s+failed/i,
];

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

export function isDeprecationNoiseLine(line: string): boolean {
  return DEPRECATION_NOISE_RE.test(line);
}

/**
 * Keeps failed-step tails and error lines; drops Node/Actions deprecation noise unless
 * it is the only remaining signal.
 */
export function condenseJobLogText(
  raw: string,
  maxChars: number = REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let sawRealError = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isDeprecationNoiseLine(line)) continue;
    const isMarker = FAILED_STEP_MARKERS.some((re) => re.test(line));
    const isError = ERROR_SIGNAL_RE.test(line) && !isDeprecationNoiseLine(line);
    if (isMarker || isError) {
      sawRealError = true;
      const start = Math.max(0, i - 2);
      for (let j = start; j <= i; j++) {
        const candidate = lines[j] ?? "";
        if (isDeprecationNoiseLine(candidate)) continue;
        kept.push(candidate);
      }
      // Keep a short tail after the error for context.
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const candidate = lines[j] ?? "";
        if (isDeprecationNoiseLine(candidate)) continue;
        kept.push(candidate);
      }
    }
  }

  let condensed: string;
  if (kept.length > 0) {
    condensed = collapseBlankLines([...new Set(kept)].join("\n"));
  } else if (!sawRealError) {
    // No real errors found: keep the last non-noise lines (may include deprecation if sole signal).
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
