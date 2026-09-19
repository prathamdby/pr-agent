import { CaretDownIcon } from "@phosphor-icons/react";
import { Section, SectionHeading } from "@/components/ui/section";
import { FAQ_ITEMS } from "@/lib/content";

/** Native disclosures. Nine questions is past the point where a flat list reads well. */
export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-heading">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-20">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <SectionHeading id="faq-heading">Questions teams ask before they deploy</SectionHeading>
        </div>

        <div className="divide-y divide-line border-y border-line">
          {FAQ_ITEMS.map((item) => (
            <details key={item.question} className="group">
              <summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-left text-base font-medium text-fg [&::-webkit-details-marker]:hidden">
                {item.question}
                <CaretDownIcon className="disclosure-icon size-4 shrink-0 text-fg-subtle" />
              </summary>
              <p className="max-w-[65ch] pb-6 text-base leading-relaxed text-fg-muted">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}
