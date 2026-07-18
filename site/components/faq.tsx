import { Section } from "@/components/section";
import { FAQ_ITEMS } from "@/lib/content";

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-heading">
      <h2
        id="faq-heading"
        className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
      >
        Questions teams ask before they deploy
      </h2>

      <dl className="mt-12 grid gap-x-12 gap-y-10 lg:grid-cols-2">
        {FAQ_ITEMS.map((item) => (
          <div key={item.question} className="min-w-0">
            <dt className="text-base font-medium text-ink">{item.question}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-ink-mute">{item.answer}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
