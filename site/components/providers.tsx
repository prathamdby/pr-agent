import { PROVIDERS } from "@/lib/content";

export function Providers() {
  return (
    <section
      id="providers"
      aria-labelledby="providers-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="providers-heading" className="text-xl mb-4">
          Change models without retraining your team
        </h2>

        <ul className="space-y-3 text-sm">
          {PROVIDERS.map((provider) => (
            <li key={provider.name}>
              <h3 className="font-medium text-neutral-800">{provider.name}</h3>
              <p className="text-neutral-600">{provider.detail}</p>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-sm text-neutral-500">
          Switch from GPT to Claude to DeepSeek by changing a setting. Your GitHub workflow stays
          the same. See{" "}
          <a href="#usage" className="underline hover:text-neutral-700">
            Docker Compose setup
          </a>{" "}
          or the repo README.
        </p>
      </div>
    </section>
  );
}
