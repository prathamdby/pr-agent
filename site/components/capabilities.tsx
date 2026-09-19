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
  Six capabilities, six cells, two rows of four columns. Each row mixes one double-width cell
  with single cells so the grid has rhythm. Two cells carry a tint so the grid is not six
  identical white tiles. Below `md` the grid collapses to one column.
*/
const ICONS: readonly Icon[] = [
  MagnifyingGlassIcon,
  FileTextIcon,
  ChatCircleTextIcon,
  ArrowsClockwiseIcon,
  WrenchIcon,
  LightningIcon,
];

const CELLS = ["md:col-span-2", "", "", "", "md:col-span-2", ""] as const;

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

      <Reveal as="ul" className="mt-12 grid gap-4 md:grid-cols-4">
        {CAPABILITIES.map((cap, index) => {
          const Glyph = ICONS[index] ?? LightningIcon;
          const command = commandFrom(cap.trigger);
          return (
            <RevealItem
              key={cap.title}
              as="li"
              className={`card flex min-h-[14rem] flex-col rounded-panel p-6 ${CELLS[index] ?? ""}`}
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
