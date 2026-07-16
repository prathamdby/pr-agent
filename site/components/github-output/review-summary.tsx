import {
  GhCode,
  GhDetails,
  GhKvTable,
  GhNote,
  OutputFrame,
} from "@/components/github-output/primitives";

export type ReviewLens = "review" | "review-security" | "review-quality";

const SENTINEL: Record<ReviewLens, string> = {
  review: "PR Agent Review",
  "review-security": "PR Agent Security Review",
  "review-quality": "PR Agent Quality Review",
};

const OVERVIEW: Record<ReviewLens, string> = {
  review:
    "Adds a retry wrapper around the webhook dispatcher so transient GitHub failures do not drop deliveries.",
  "review-security":
    "Security pass on webhook intake and publish paths for auth and secret-handling risks.",
  "review-quality": "Maintainability pass on settings routing and publish helpers.",
};

type Finding = {
  readonly severity: string;
  readonly confidence: string;
  readonly title: string;
  readonly file: string;
  readonly lines: string;
  readonly marker: "On the diff" | "Summary only";
};

const FINDINGS: Record<ReviewLens, readonly Finding[]> = {
  review: [
    {
      severity: "P1",
      confidence: "c4",
      title: "Webhook ack can race the durable write",
      file: "src/webhooks/intake.ts",
      lines: "lines 148-152",
      marker: "On the diff",
    },
    {
      severity: "P2",
      confidence: "c3",
      title: "Summary edit ignores stale head guard",
      file: "src/review/publish.ts",
      lines: "line 91",
      marker: "Summary only",
    },
  ],
  "review-security": [
    {
      severity: "P1",
      confidence: "c4",
      title: "Webhook secret compared with a non-constant-time check",
      file: "src/webhooks/verify.ts",
      lines: "lines 36-41",
      marker: "On the diff",
    },
    {
      severity: "P2",
      confidence: "c3",
      title: "Error path may echo provider response bodies",
      file: "src/agent/providerErrors.ts",
      lines: "lines 88-94",
      marker: "Summary only",
    },
  ],
  "review-quality": [
    {
      severity: "P2",
      confidence: "c3",
      title: "Settings read duplicated across three call sites",
      file: "src/settings/runtime.ts",
      lines: "lines 44-61",
      marker: "On the diff",
    },
    {
      severity: "P3",
      confidence: "c2",
      title: "Publish helper mixes formatting and I/O",
      file: "src/review/publish/publishReview.ts",
      lines: "lines 210-240",
      marker: "Summary only",
    },
  ],
};

const VERDICT: Record<ReviewLens, { score: string; rationale: string }> = {
  review: {
    score: "3/5",
    rationale: "Fix the intake race before merge on this pass.",
  },
  "review-security": {
    score: "2/5",
    rationale: "Resolve the timing-safe compare before merge on this pass.",
  },
  "review-quality": {
    score: "4/5",
    rationale: "No blocking findings on this pass.",
  },
};

const SECURITY_ROW: Record<ReviewLens, string> = {
  review: "None found on this pass",
  "review-security": "Timing-safe compare gap on webhook verification.",
  "review-quality": "None found on this pass",
};

type ReviewSummaryMockProps = {
  readonly lens?: ReviewLens;
};

export function ReviewSummaryMock({ lens = "review" }: ReviewSummaryMockProps) {
  const findings = FINDINGS[lens];
  const verdict = VERDICT[lens];

  const rows = [
    {
      label: "Effort",
      value: (
        <>
          Moderate · <GhCode>3/5</GhCode>
        </>
      ),
    },
    ...findings.map((finding) => ({
      label: `${finding.severity} · ${finding.confidence}`,
      value: (
        <div className="space-y-0.5">
          <p className="font-semibold text-ink-soft">{finding.title}</p>
          <p className="text-[11px] italic text-ink-faint">
            {finding.marker} · <GhCode>{finding.file}</GhCode> · {finding.lines}
          </p>
        </div>
      ),
    })),
    { label: "Relevant tests", value: "partial" },
    { label: "Security", value: SECURITY_ROW[lens] },
    {
      label: "Merge verdict",
      value: (
        <>
          <GhCode>{verdict.score}</GhCode> · {verdict.rationale}
        </>
      ),
    },
  ];

  return (
    <OutputFrame title={SENTINEL[lens]} surface="PR conversation comment">
      <GhNote>{OVERVIEW[lens]}</GhNote>
      <GhKvTable rows={rows} />
      <GhDetails summary="Prompt to fix">
        <pre className="font-mono text-[11px] leading-relaxed text-ink-soft">
          <code>Verify each finding against current code. Fix only still-valid issues.</code>
        </pre>
      </GhDetails>
    </OutputFrame>
  );
}
