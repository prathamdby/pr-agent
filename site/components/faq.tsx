import { FAQ_ITEMS } from "@/lib/seo";

export function Faq() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="border-t border-border-line"
      data-line
    >
      <div className="grid-layout py-16">
        <div className="col-span-4 md:col-span-12 lg:col-span-24">
          <h2 id="faq-heading" className="section-title mb-10">
            Frequently asked questions
          </h2>
        </div>

        <div className="col-span-4 md:col-span-12 lg:col-span-24 max-w-3xl mx-auto">
          <dl className="divide-y divide-border-line">
            {FAQ_ITEMS.map((item) => (
              <div key={item.question} className="py-5 first:pt-0 last:pb-0">
                <dt className="font-semibold text-foreground-primary mb-2 text-base">
                  {item.question}
                </dt>
                <dd className="text-sm text-foreground-secondary leading-relaxed">
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
