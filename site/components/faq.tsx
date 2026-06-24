import { FAQ_ITEMS } from "@/lib/seo";

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-heading" data-line>
      <div className="grid-layout">
        <div className="grid-layout-inner py-16 md:py-20">
          <h2 id="faq-heading" className="section-title mb-3 text-foreground-primary">
            Frequently asked questions
          </h2>
          <p className="mb-10 text-center text-foreground-secondary max-w-lg mx-auto">
            Everything you need to know about deploying and running PR Agent.
          </p>

          <dl className="mx-auto max-w-2xl divide-y divide-border-line">
            {FAQ_ITEMS.map((item) => (
              <div key={item.question} className="py-5">
                <dt className="text-base font-medium text-foreground-primary">{item.question}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-foreground-secondary">
                  {item.answer}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
