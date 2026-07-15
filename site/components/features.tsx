import { FEATURES } from "@/lib/content";

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="features-heading" className="text-xl mb-4">
          Stop burning reviewer time on repeat checks
        </h2>

        <ul className="space-y-4">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="text-sm">
              <h3 className="font-medium text-neutral-800">{feature.title}</h3>
              <p className="text-neutral-600 mt-0.5">{feature.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
