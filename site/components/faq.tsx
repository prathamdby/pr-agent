import { FAQ_ITEMS } from "@/lib/seo";

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-heading" className="section section-border">
      <div className="container-geist">
        <div className="mx-auto max-w-2xl">
          <h2 id="faq-heading" className="heading-32 mb-10 text-center">
            Frequently Asked Questions
          </h2>

          <dl className="divide-y divide-gray-alpha-400">
            {FAQ_ITEMS.map((item) => (
              <div key={item.question} className="py-6 first:pt-0 last:pb-0">
                <dt className="heading-16 mb-2">{item.question}</dt>
                <dd className="copy-14 text-gray-900 leading-relaxed">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
