import { FAQ_ITEMS } from "@/lib/seo";

export function Faq() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="border-t border-gray-alpha-200 bg-background-200 px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2 id="faq-heading" className="text-heading-24 text-primary sm:text-heading-32">
          Frequently Asked Questions
        </h2>

        <dl className="mt-10 grid gap-6 sm:grid-cols-2">
          {FAQ_ITEMS.map((item) => (
            <div key={item.question}>
              <dt className="text-heading-14 text-primary">{item.question}</dt>
              <dd className="mt-2 text-copy-14 text-secondary">{item.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
