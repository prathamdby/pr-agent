import {
  VERIFICATION_FAILURE_END,
  VERIFICATION_FAILURE_START,
  VERIFICATION_FAILURE_TEXT,
} from "../../settings/index.js";

const CI_SUMMARY_CELL_END = "<!-- /pr-agent:ci-summary -->";
const CI_SUMMARY_CELL_RE =
  /<!--\s*pr-agent:ci-summary\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*-->/;

export type VerificationFailureSurface = "ci_cell" | "stub_line";

export type AppliedVerificationFailure = {
  readonly nextBody: string;
  readonly surface: VerificationFailureSurface;
  readonly changed: boolean;
};

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

export function preserveVerificationFailureBlock(previousBody: string, nextBody: string): string {
  const failure = extractVerificationFailureBlock(previousBody);
  if (failure == null || nextBody.includes(VERIFICATION_FAILURE_START)) return nextBody;
  return injectVerificationFailureIntoCiCell(nextBody, failure);
}

export function applyVerificationFailureToComment(body: string): AppliedVerificationFailure {
  const block = renderVerificationFailureBlock();
  if (CI_SUMMARY_CELL_RE.test(body)) {
    const nextBody = commentHasVerificationFailure(body)
      ? body.replace(VERIFICATION_FAILURE_BLOCK_RE, block)
      : body.replace(CI_SUMMARY_CELL_END, `${block}${CI_SUMMARY_CELL_END}`);
    return { nextBody, surface: "ci_cell", changed: nextBody !== body };
  }
  if (commentHasVerificationFailure(body)) {
    const nextBody = body.replace(VERIFICATION_FAILURE_BLOCK_RE, block);
    return { nextBody, surface: "stub_line", changed: nextBody !== body };
  }
  const nextBody = `${body.trimEnd()}\n\n${block}\n`;
  return { nextBody, surface: "stub_line", changed: true };
}

export function stripVerificationFailureFromComment(body: string): {
  readonly nextBody: string;
  readonly changed: boolean;
} {
  if (!commentHasVerificationFailure(body)) {
    return { nextBody: body, changed: false };
  }
  const nextBody = body.replace(VERIFICATION_FAILURE_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
  return { nextBody, changed: nextBody !== body };
}
