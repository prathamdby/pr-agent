import { derivedFindingId, type FindingId } from "../findingIdentity/findingMarker.ts";
import { redactReviewText } from "../findings/reviewPublicOutput.ts";
import type { ReviewFinding } from "../reviewSchema.ts";
import { REVIEW_DISPOSITION_NOTE_MAX_CHARS } from "../../settings/index.ts";
import type { FindingLedger, SpecialistId } from "./orchestratorTypes.ts";
import type { SpecialistReport } from "./specialistReport.ts";

export const REJECTED_DISPOSITION_REASONS = [
  "unconfirmed_trigger",
  "already_covered",
  "guarded",
  "unreachable",
  "out_of_contract",
  "wrong_anchor",
  "library_misread",
] as const;

export type RejectedDispositionReason = (typeof REJECTED_DISPOSITION_REASONS)[number];

export type JudgmentDisposition = {
  readonly candidateId: string;
  readonly verdict: "accepted" | "rejected";
  readonly reason: "confirmed" | RejectedDispositionReason;
  readonly note?: string;
};

export type AwaitingCandidate = {
  readonly candidateId: FindingId;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
};

export type StoredDisposition = {
  readonly id: string;
  readonly verdict: "accepted" | "rejected";
  readonly reason: JudgmentDisposition["reason"];
  readonly note?: string;
};

type Identity = {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
};

export function candidateFindingId(params: { readonly specialist: string } & Identity) {
  return ((pinnedReturn: FindingId) => pinnedReturn)(
    derivedFindingId([
      params.specialist,
      params.file,
      String(params.startLine),
      String(params.endLine),
      params.title,
    ]),
  );
}

export function awaitingCandidates(
  specialist: SpecialistId,
  report: SpecialistReport | null,
  ledger: FindingLedger,
) {
  if (report == null) return ((pinnedReturn: readonly AwaitingCandidate[]) => pinnedReturn)([]);
  const seen = new Set<string>();
  const awaiting: AwaitingCandidate[] = [];
  for (const finding of report.findings) {
    if (alreadyJudged(specialist, finding, ledger)) continue;
    const candidateId = candidateFindingId({ specialist, ...finding });
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    awaiting.push({
      candidateId,
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      title: finding.title,
    });
  }
  return ((pinnedReturn: readonly AwaitingCandidate[]) => pinnedReturn)(awaiting);
}

export function dispositionMismatch(params: {
  readonly specialist: SpecialistId;
  readonly report: SpecialistReport | null;
  readonly ledger: FindingLedger;
  readonly findings: readonly Identity[];
  readonly dispositions: readonly JudgmentDisposition[];
}) {
  const awaiting = awaitingCandidates(params.specialist, params.report, params.ledger);
  const expected = new Set<string>(awaiting.map((candidate) => candidate.candidateId));
  const seen = new Set<string>();
  for (const disposition of params.dispositions) {
    if (seen.has(disposition.candidateId)) {
      return ((pinnedReturn: string | undefined) => pinnedReturn)(
        `disposition candidate ${disposition.candidateId} is repeated`,
      );
    }
    seen.add(disposition.candidateId);
    if (!expected.has(disposition.candidateId)) {
      return ((pinnedReturn: string | undefined) => pinnedReturn)(
        `disposition candidate ${disposition.candidateId} is not awaiting judgment`,
      );
    }
  }
  for (const candidateId of expected) {
    if (!seen.has(candidateId))
      return ((pinnedReturn: string | undefined) => pinnedReturn)(
        `disposition missing for candidate ${candidateId}`,
      );
  }
  const accepted = new Set(
    params.dispositions
      .filter((disposition) => disposition.verdict === "accepted")
      .map((disposition) => disposition.candidateId),
  );
  const published = new Set<string>(
    params.findings.map((finding) =>
      candidateFindingId({ specialist: params.specialist, ...finding }),
    ),
  );
  for (const candidateId of published) {
    if (!accepted.has(candidateId)) {
      return ((pinnedReturn: string | undefined) => pinnedReturn)(
        `published finding ${candidateId} has no accepted disposition`,
      );
    }
  }
  for (const candidateId of accepted) {
    if (!published.has(candidateId)) {
      return ((pinnedReturn: string | undefined) => pinnedReturn)(
        `accepted disposition ${candidateId} is not in the published batch`,
      );
    }
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
}

export function storedDispositions(params: {
  readonly specialist: SpecialistId;
  readonly dispositions: readonly JudgmentDisposition[];
  readonly awaiting: readonly AwaitingCandidate[];
  readonly ledger: FindingLedger;
}) {
  return ((pinnedReturn: readonly StoredDisposition[]) => pinnedReturn)(
    params.dispositions.map((disposition) => {
      const note = dispositionNote(disposition.note);
      const id =
        disposition.verdict === "rejected"
          ? disposition.candidateId
          : mintedId(params.specialist, disposition.candidateId, params.awaiting, params.ledger);
      return {
        id,
        verdict: disposition.verdict,
        reason: disposition.reason,
        ...(note != null ? { note } : {}),
      };
    }),
  );
}

export function dispositionNote(note: string | undefined) {
  if (note == null) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const redacted = redactReviewText(note);
  if (redacted !== note) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const capped = redacted.slice(0, REVIEW_DISPOSITION_NOTE_MAX_CHARS);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    capped.length === 0 ? undefined : capped,
  );
}

function alreadyJudged(specialist: SpecialistId, finding: Identity, ledger: FindingLedger) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    ledger.accepted.some(
      (entry) =>
        entry.source === specialist &&
        entry.placement.finding.file === finding.file &&
        entry.placement.finding.startLine === finding.startLine &&
        entry.placement.finding.endLine === finding.endLine &&
        entry.placement.finding.title === finding.title,
    ),
  );
}

function mintedId(
  specialist: SpecialistId,
  candidateId: string,
  awaiting: readonly AwaitingCandidate[],
  ledger: FindingLedger,
) {
  const candidate = awaiting.find((entry) => entry.candidateId === candidateId);
  if (candidate == null) return ((pinnedReturn: string) => pinnedReturn)(candidateId);
  const accepted = ledger.accepted.find(
    (entry) => entry.source === specialist && sameIdentity(entry.placement.finding, candidate),
  );
  if (accepted != null) return ((pinnedReturn: string) => pinnedReturn)(accepted.findingId);
  const reaffirmed = ledger.reaffirmed.find(
    (entry) => entry.source === specialist && sameIdentity(entry.placement.finding, candidate),
  );
  return ((pinnedReturn: string) => pinnedReturn)(reaffirmed?.id ?? candidateId);
}

function sameIdentity(finding: ReviewFinding, candidate: Identity) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    finding.file === candidate.file &&
      finding.startLine === candidate.startLine &&
      finding.endLine === candidate.endLine &&
      finding.title === candidate.title,
  );
}
