import {
  GhCode,
  GhComment,
  GhDetails,
  GhKvTable,
  GhNote,
  GhPre,
  GhTitle,
} from "@/components/github-output/primitives";

type Finding = {
  readonly severity: string;
  readonly confidence: string;
  readonly title: string;
  readonly file: string;
  readonly lines: string;
  readonly marker: "On the diff" | "Summary only";
};

const FINDINGS: readonly Finding[] = [
  {
    severity: "P1",
    confidence: "c4",
    title: "Webhook ack can race the durable write",
    file: "src/webhooks/intake.ts",
    lines: "lines 148–152",
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
];

const FOLLOW_UPS: readonly string[] = [
  "1. Remove the retry feature flag once metrics confirm the fix",
  "2. Delete the legacy dispatcher path once the batched dispatcher ships",
];

type ReviewSummaryMockProps = {
  /** Drop the trailing rows so the comment fits a cropped preview. */
  readonly compact?: boolean;
  readonly frame?: "inline" | "window";
};

/** Mirrors the `## PR Agent Review` summary comment. */
export function ReviewSummaryMock({ compact = false, frame = "inline" }: ReviewSummaryMockProps) {
  const rows = [
    { label: "Size", value: <GhCode>M</GhCode> },
    ...FINDINGS.map((finding) => ({
      label: `${finding.severity} · ${finding.confidence}`,
      value: (
        <div className="space-y-0.5">
          <p className="font-medium text-text">{finding.title}</p>
          <p className="text-[11px] text-text-tertiary italic">
            {finding.marker} · <GhCode>{finding.file}</GhCode> · {finding.lines}
          </p>
        </div>
      ),
    })),
    {
      label: "Mergeability",
      value: "Two-way: trivial to revert; only error-message rendering.",
    },
    ...(compact
      ? []
      : [
          {
            label: "Blast radius",
            value: "Localized: stream error text only; no API, schema, or control-flow change.",
          },
          {
            label: "Follow-ups",
            value: (
              <div className="space-y-0.5">
                {FOLLOW_UPS.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            ),
          },
        ]),
  ];

  return (
    <GhComment surface="Pull request conversation" frame={frame}>
      <GhTitle>PR Agent Review</GhTitle>
      <GhNote>
        Adds a retry wrapper around the webhook dispatcher so transient GitHub failures do not drop
        deliveries.
      </GhNote>
      <GhKvTable rows={rows} />
      {compact ? null : (
        <GhDetails summary="Prompt to fix">
          <GhPre>Verify each finding against current code. Fix only still-valid issues.</GhPre>
        </GhDetails>
      )}
    </GhComment>
  );
}
