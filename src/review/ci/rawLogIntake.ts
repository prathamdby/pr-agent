import {
  REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
  REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE,
} from "../../settings/index.js";

/** Runner / toolchain noise that must not beat a real test/lint/build failure. */
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

export function isDeprecationNoiseLine(line: string): boolean {
  return DEPRECATION_NOISE_RE.test(line);
}

export function lineHasCiErrorSignal(line: string): boolean {
  if (isDeprecationNoiseLine(line)) {
    return false;
  }
  return FAILED_STEP_MARKERS.some((re) => re.test(line)) || ERROR_SIGNAL_RE.test(line);
}

export function rawLogIntakeCap(
  perJobMaxChars: number = REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
): number {
  return perJobMaxChars * REVIEW_CI_SUMMARY_LOG_RAW_TAIL_MULTIPLE;
}

function lastCiErrorLineRange(raw: string): { start: number; end: number } | null {
  let end = raw.length;
  while (end > 0) {
    const newline = raw.lastIndexOf("\n", end - 1);
    const start = newline + 1;
    if (lineHasCiErrorSignal(raw.slice(start, end))) {
      return { start, end: end < raw.length ? end + 1 : end };
    }
    if (newline < 0) {
      break;
    }
    end = newline;
  }
  return null;
}

function textHasCiErrorSignal(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  let from = 0;
  while (from < text.length) {
    const newline = text.indexOf("\n", from);
    const end = newline === -1 ? text.length : newline;
    if (lineHasCiErrorSignal(text.slice(from, end))) {
      return true;
    }
    if (newline === -1) {
      break;
    }
    from = newline + 1;
  }
  return false;
}

/**
 * Bounds raw job-log intake to `perJobMaxChars * RAW_TAIL_MULTIPLE`.
 * Keeps the tail when that window already has an error signal.
 * Otherwise keeps a cap-sized window that still includes the last error line.
 */
export function boundRawLogIntake(
  raw: string,
  perJobMaxChars: number = REVIEW_CI_SUMMARY_LOG_PER_JOB_MAX_CHARS,
): string {
  const cap = rawLogIntakeCap(perJobMaxChars);
  if (raw.length <= cap) {
    return raw;
  }

  const tail = raw.slice(raw.length - cap);
  if (textHasCiErrorSignal(tail)) {
    return tail;
  }

  const error = lastCiErrorLineRange(raw);
  if (error == null) {
    return tail;
  }

  const start = Math.max(0, error.end - cap);
  return raw.slice(start, start + cap);
}
