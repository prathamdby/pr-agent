import {
  ArrowsClockwiseIcon,
  ChatCircleTextIcon,
  FileTextIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  WrenchIcon,
  type Icon,
} from "@phosphor-icons/react";
import { Reveal, RevealItem } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/section";
import { CAPABILITIES } from "@/lib/content";

/*
  Six capabilities. Phone is one column, tablet is two, wide screens are four with a
  double-width cell on each row so the grid has rhythm.
*/
const ICONS: readonly Icon[] = [
  MagnifyingGlassIcon,
  FileTextIcon,
  ChatCircleTextIcon,
  ArrowsClockwiseIcon,
  WrenchIcon,
  LightningIcon,
];

const CELLS = ["xl:col-span-2", "", "", "", "xl:col-span-2", ""] as const;

function commandFrom(trigger: string): string | null {
  return trigger.match(/\/[a-z-]+/)?.[0] ?? null;
}

export function Capabilities() {
  return (
    <Section id="capabilities" labelledBy="capabilities-heading" tone="surface">
      <SectionHeading
        id="capabilities-heading"
        lede="Ask from a pull request comment, or let the automatic path run when a pull request opens."
      >
        What your team gets back in GitHub
      </SectionHeading>

      <Reveal as="ul" className="mt-10 grid gap-4 sm:grid-cols-2 sm:mt-12 xl:grid-cols-4">
        {CAPABILITIES.map((cap, index) => {
          const Glyph = ICONS[index] ?? LightningIcon;
          const command = commandFrom(cap.trigger);
          return (
            <RevealItem
              key={cap.title}
              as="li"
              className={`card flex min-h-[12rem] flex-col rounded-panel p-5 sm:min-h-[14rem] sm:p-6 ${CELLS[index] ?? ""}`}
            >
              <div className="flex items-center justify-between gap-3">
                <Glyph weight="duotone" className="size-6 text-blue" />
                <code className="rounded-[6px] bg-well px-2 py-1 text-[12px] font-medium text-fg shadow-[inset_0_0_0_1px_var(--color-line)]">
                  {command ?? "automatic"}
                </code>
              </div>
              <div className="mt-auto pt-8">
                <h3 className="text-lg font-semibold leading-snug text-fg">{cap.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">{cap.detail}</p>
              </div>
            </RevealItem>
          );
        })}
      </Reveal>
    </Section>
  );
}
