import {
  VERIFICATION_FAILURE_END,
  VERIFICATION_FAILURE_START,
  VERIFICATION_FAILURE_TEXT,
} from "../../settings/index.js";

const CI_SUMMARY_CELL_END = "<!-- /pr-agent:ci-summary -->";
const CI_SUMMARY_CELL_RE =
  /<!--\s*pr-agent:ci-summary(?:\s+head=[^\s]+)?(?:\s+v=\d+)?\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*-->/;

export type VerificationFailureSurface = "ci_cell" | "stub_line";

const VERIFICATION_FAILURE_BLOCK_RE =
  /<!--\s*pr-agent:verification-failure\s*-->[\s\S]*?<!--\s*\/pr-agent:verification-failure\s*-->/;

export function renderVerificationFailureBlock(): string {
  return `${VERIFICATION_FAILURE_START}${VERIFICATION_FAILURE_TEXT}${VERIFICATION_FAILURE_END}`;
}

export function renderClearedVerificationFailureStub(): string {
  return `${VERIFICATION_FAILURE_START}${VERIFICATION_FAILURE_END}`;
}

export function extractVerificationFailureBlock(body: string): string | undefined {
  return body.match(VERIFICATION_FAILURE_BLOCK_RE)?.[0];
}

export function isClearedVerificationFailureStub(body: string): boolean {
  return body.trim() === renderClearedVerificationFailureStub();
}

function commentHasVerificationFailure(body: string): boolean {
  return VERIFICATION_FAILURE_BLOCK_RE.test(body);
}

export function commentHasVisibleVerificationFailure(body: string): boolean {
  return commentHasVerificationFailure(body) && !isClearedVerificationFailureStub(body);
}

export function injectVerificationFailureIntoCiCell(body: string, block: string): string {
  if (body.includes(VERIFICATION_FAILURE_START) || !CI_SUMMARY_CELL_RE.test(body)) return body;
  return body.replace(CI_SUMMARY_CELL_END, `${block}${CI_SUMMARY_CELL_END}`);
}
