import { Section } from "@/components/section";
import { FAQ_ITEMS } from "@/lib/content";

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-heading">
      <h2
        id="faq-heading"
        className="font-display text-[clamp(1.5rem,2.8vw,2.15rem)] leading-tight text-ink"
      >
        Questions teams ask before they deploy
      </h2>

      <dl className="mt-6 grid gap-x-10 gap-y-6 lg:grid-cols-2">
        {FAQ_ITEMS.map((item) => (
          <div key={item.question} className="min-w-0">
            <dt className="text-sm font-medium text-ink">{item.question}</dt>
            <dd className="mt-1.5 text-sm leading-snug text-ink-mute">{item.answer}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
