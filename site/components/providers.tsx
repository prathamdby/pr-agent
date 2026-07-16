import { PROVIDERS } from "@/lib/content";

export function Providers() {
  return (
    <section
      id="providers"
      aria-labelledby="providers-heading"
      className="px-4 py-16 sm:px-6 sm:py-20 md:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <h2
          id="providers-heading"
          className="max-w-[18ch] font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
        >
          Change models without retraining your team
        </h2>

        <ul className="mt-12 grid gap-10 sm:grid-cols-2">
          {PROVIDERS.map((provider) => (
            <li key={provider.name} className="min-w-0">
              <h3 className="font-display text-2xl text-ink">{provider.name}</h3>
              <p className="mt-3 text-sm leading-relaxed text-ink-mute">{provider.detail}</p>
            </li>
          ))}
        </ul>

        <p className="mt-10 max-w-xl text-sm text-ink-faint">
          Switch from GPT to Claude to DeepSeek by changing a setting. Your GitHub workflow stays
          the same. See{" "}
          <a href="#usage" className="text-ink-soft underline decoration-edge-strong hover:text-ink">
            Docker Compose setup
          </a>{" "}
          or the repo README.
        </p>
      </div>
    </section>
  );
}
