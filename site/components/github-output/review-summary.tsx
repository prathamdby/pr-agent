import {
  GhCode,
  GhDetails,
  GhKvTable,
  GhNote,
  OutputFrame,
} from "@/components/github-output/primitives";

export type ReviewLens = "review" | "review-security" | "review-quality";

type ReviewLensCopy = {
  readonly review: string;
  readonly "review-security": string;
  readonly "review-quality": string;
};

const SENTINEL: ReviewLensCopy = {
  review: "PR Agent Review",
  "review-security": "PR Agent Security Review",
  "review-quality": "PR Agent Quality Review",
};

const OVERVIEW: ReviewLensCopy = {
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

type FindingsByLens = {
  readonly review: readonly Finding[];
  readonly "review-security": readonly Finding[];
  readonly "review-quality": readonly Finding[];
};

const FINDINGS: FindingsByLens = {
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

const SECURITY_ROW: ReviewLensCopy = {
  review: "None found on this pass",
  "review-security": "Timing-safe compare gap on webhook verification.",
  "review-quality": "None found on this pass",
};

type ReviewSummaryMockProps = {
  readonly lens?: ReviewLens;
};

export function ReviewSummaryMock({ lens = "review" }: ReviewSummaryMockProps) {
  const findings = FINDINGS[lens];

  const rows = [
    {
      label: "Size",
      value: <GhCode>M</GhCode>,
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
