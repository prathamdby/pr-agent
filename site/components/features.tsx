import { FEATURES } from "@/lib/content";

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="px-4 py-16 sm:px-6 sm:py-20 md:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <h2
            id="features-heading"
            className="max-w-[16ch] font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
          >
            Stop burning reviewer time on repeat checks
          </h2>

          <ol className="space-y-0">
            {FEATURES.map((feature, index) => (
              <li
                key={feature.title}
                className="grid grid-cols-[3rem_minmax(0,1fr)] gap-4 border-t border-edge py-6 first:border-t-0 first:pt-0"
              >
                <span className="font-mono text-sm text-ink-faint">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-base font-medium text-ink">{feature.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-mute">{feature.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
