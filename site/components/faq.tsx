import { FAQ_ITEMS } from "@/lib/seo";

export function Faq() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="faq-heading" className="text-xl mb-4">
          Frequently asked questions
        </h2>

        <dl className="space-y-5">
          {FAQ_ITEMS.map((item) => (
            <div key={item.question}>
              <dt className="text-sm font-medium text-neutral-800">{item.question}</dt>
              <dd className="mt-1 text-sm text-neutral-600">{item.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
