import { FAQ_ITEMS } from "@/lib/content";

export function Faq() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="px-4 py-16 sm:px-6 sm:py-20 md:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <h2
          id="faq-heading"
          className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
        >
          Questions teams ask before they deploy
        </h2>

        <dl className="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-2">
          {FAQ_ITEMS.map((item) => (
            <div key={item.question} className="min-w-0">
              <dt className="text-base font-medium text-ink">{item.question}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-mute">{item.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
