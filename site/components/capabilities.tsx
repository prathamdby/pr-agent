import type { ComponentType, ReactNode } from "react";
import { GhPill } from "@/components/github-output/primitives";
import { Document, Eye, Info, Question, Refresh, Wrench } from "@/components/icons";
import { Section, SectionHeading } from "@/components/section";
import { CAPABILITIES, type CapabilityId } from "@/lib/content";

type IconComponent = ComponentType<{ readonly className?: string }>;

const BY_ID = new Map(CAPABILITIES.map((item) => [item.id, item]));

/** Every card below reads its copy from `CAPABILITIES`; only the arrangement lives here. */
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

function IconTile({ icon: Icon }: { readonly icon: IconComponent }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-accent-soft text-accent-text">
      <Icon className="size-5" />
    </span>
  );
}

function CommandChip({ value }: { readonly value: string | null }) {
  if (value === null) {
    return (
      <span className="rounded-xs bg-surface-raised px-2 py-1 text-xs font-medium text-text-secondary shadow-ring">
        Automatic
      </span>
    );
  }
  return (
    <code className="rounded-xs bg-surface-raised px-2 py-1 font-mono text-xs font-medium text-accent-text shadow-ring">
      {value}
    </code>
  );
}

function Copy({ id }: { readonly id: CapabilityId }) {
  const item = capability(id);
  return (
    <>
      <h3 className="text-[17px] leading-snug font-medium text-text">{item.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.trigger}.</p>
      <p className="mt-3 text-sm leading-relaxed text-text-tertiary">{item.detail}</p>
    </>
  );
}

function Card({
  id,
  icon,
  className,
  children,
}: {
  readonly id: CapabilityId;
  readonly icon: IconComponent;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const item = capability(id);
  return (
    <li className={`flex flex-col rounded-lg bg-surface p-6 shadow-card ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <IconTile icon={icon} />
        <CommandChip value={command(item.trigger)} />
      </div>
      <div className="mt-5">
        <Copy id={id} />
      </div>
      {children}
    </li>
  );
}

/**
 * Dashed rail segment. A wrapper takes the insets because an absolutely positioned SVG is a
 * replaced element and would keep its intrinsic height instead of stretching between them.
 */
function Rail({ className }: { readonly className: string }) {
  return (
    <span aria-hidden="true" className={`pointer-events-none absolute left-0 w-10 ${className}`}>
      <svg className="h-full w-full text-line" preserveAspectRatio="none">
        <line x1="20.5" y1="0" x2="20.5" y2="100%" stroke="currentColor" strokeDasharray="3 3" />
      </svg>
    </span>
  );
}

/**
 * Review and verify share one card: the first pass, then the recheck that follows every push.
 * One dashed rail runs from the review tile through a small info mark and behind the verify
 * tile, then turns with a rounded corner into the middle of the verify copy.
 */
function ReviewLoopCard() {
  const review = capability("review");
  const verify = capability("verify");
  return (
    <li className="flex flex-col rounded-lg bg-surface p-6 shadow-card sm:row-span-2">
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4">
        <div className="relative">
          <Rail className="top-5 bottom-0" />
          <div className="relative z-10">
            <IconTile icon={Eye} />
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex h-10 items-center">
            <CommandChip value={command(review.trigger)} />
          </div>
          <div className="mt-3">
            <Copy id="review" />
          </div>
        </div>

        <div className="relative flex h-20 items-center justify-center">
          <Rail className="inset-y-0" />
          <span className="relative z-10 grid size-[18px] place-items-center rounded-full bg-accent-solid text-on-accent">
            <Info className="size-3.5" />
          </span>
        </div>
        <p className="flex h-20 items-center text-xs text-text-tertiary">Then, after every push</p>

        <div className="relative">
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 h-40 w-14 text-line"
            viewBox="0 0 56 160"
            fill="none"
          >
            <path
              d="M20.5 0V126a16 16 0 0 0 16 16H52"
              stroke="currentColor"
              strokeDasharray="3 3"
            />
          </svg>
          <div className="relative z-10">
            <IconTile icon={Refresh} />
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex h-10 items-center">
            <CommandChip value={command(verify.trigger)} />
          </div>
          <div className="mt-3">
            <Copy id="verify" />
          </div>
        </div>
      </div>
    </li>
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

/** The verdicts a triage run leaves behind, sized for a card. Decorative. */
function TriageVerdicts() {
  return (
    <div className="wash wash-grid flex items-center rounded-md p-4 sm:p-5" aria-hidden="true">
      <div className="window w-full overflow-hidden text-xs leading-snug text-text">
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

function TriageCard() {
  const triage = capability("triage");
  return (
    <li className="rounded-lg bg-surface p-6 shadow-card sm:col-span-2">
      <div className="grid gap-6 md:grid-cols-2 md:gap-8">
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <IconTile icon={Wrench} />
            <CommandChip value={command(triage.trigger)} />
          </div>
          <div className="mt-5">
            <Copy id="triage" />
          </div>
        </div>
        <TriageVerdicts />
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

      <ul className="mt-10 grid gap-4 sm:mt-12 sm:grid-cols-2 lg:grid-cols-3">
        <ReviewLoopCard />
        <Card id="describe" icon={Document} />
        <Card id="ask" icon={Question} />
        <TriageCard />
      </ul>
    </Section>
  );
}
