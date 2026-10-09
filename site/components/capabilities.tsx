import type { ReactNode } from "react";
import { GhPill } from "@/components/github-output/primitives";
import { Section, SectionHeading } from "@/components/section";
import { CAPABILITIES, type CapabilityId } from "@/lib/content";

const BY_ID = new Map(CAPABILITIES.map((item) => [item.id, item]));

/** Every row below reads its copy from `CAPABILITIES`; only the arrangement lives here. */
function capability(id: CapabilityId) {
  const item = BY_ID.get(id);
  if (item === undefined) {
    throw new Error(`Missing capability copy for ${id}`);
  }
  return item;
}

function command(trigger: string): string | null {
  return trigger.match(/\/[a-z-]+/)?.[0] ?? null;
}

function CommandChip({ value }: { readonly value: string | null }) {
  if (value === null) {
    return <span className="chip font-medium text-text-secondary">Automatic</span>;
  }
  return <code className="chip font-mono font-medium text-accent-text">{value}</code>;
}

function Copy({ id }: { readonly id: CapabilityId }) {
  const item = capability(id);
  return (
    <>
      <h3 className="text-lead leading-snug font-medium text-text">{item.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.trigger}.</p>
      <p className="mt-3 text-sm leading-relaxed text-text-tertiary">{item.detail}</p>
    </>
  );
}

type Verdict = {
  readonly finding: string;
  readonly tone: "success" | "accent" | "neutral" | "warning";
  readonly verdict: string;
};

const VERDICTS: readonly Verdict[] = [
  { finding: "Ack races the write", tone: "success", verdict: "Fixed" },
  { finding: "Stale head guard", tone: "accent", verdict: "Resolved" },
  { finding: "Retry flag unused", tone: "neutral", verdict: "Skipped" },
  { finding: "Docs skip ack wait", tone: "warning", verdict: "Dismissed" },
];

/** The verdicts a triage run leaves behind. Decorative. */
function TriageVerdicts() {
  return (
    <div className="wash wash-grid flex items-center rounded-md p-4 sm:p-5" aria-hidden="true">
      {/* The wash padding exceeds its 12px radius, so the window steps down a size to stay concentric. */}
      <div className="window w-full overflow-hidden rounded-sm text-xs leading-snug text-text">
        <div className="border-b border-line bg-surface-raised px-3 py-2 font-semibold">
          PR Agent Triage
        </div>
        <ul className="divide-y divide-line">
          {VERDICTS.map((row) => (
            <li key={row.finding} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="truncate text-text-secondary">{row.finding}</span>
              <GhPill tone={row.tone}>{row.verdict}</GhPill>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Row({
  id,
  note,
  aside,
}: {
  readonly id: CapabilityId;
  readonly note?: string;
  readonly aside?: ReactNode;
}) {
  const item = capability(id);
  return (
    <li className="py-8">
      <div className={aside === undefined ? undefined : "grid items-center gap-8 lg:grid-cols-2"}>
        <div className="flex flex-col gap-3 sm:flex-row sm:gap-8">
          <div className="sm:w-32 sm:shrink-0 sm:pt-0.5">
            <CommandChip value={command(item.trigger)} />
          </div>
          <div className="min-w-0">
            {note === undefined ? null : <p className="mb-3 text-xs text-text-tertiary">{note}</p>}
            <Copy id={id} />
          </div>
        </div>
        {aside}
      </div>
    </li>
  );
}

export function Capabilities() {
  return (
    <Section id="capabilities" labelledBy="capabilities-heading">
      <SectionHeading
        id="capabilities-heading"
        eyebrow="Commands"
        title="What your team gets back in GitHub"
        description="Ask from a pull request comment, or let the automatic path run when a pull request opens."
      />

      <ul className="mt-10 divide-y divide-line border-t border-line sm:mt-12">
        <Row id="review" />
        <Row id="verify" note="Then, after every push" />
        <Row id="describe" />
        <Row id="ask" />
        <Row id="triage" aside={<TriageVerdicts />} />
      </ul>
    </Section>
  );
}
