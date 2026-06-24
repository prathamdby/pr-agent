const providers = [
  {
    name: "Pi (default)",
    detail:
      "OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Groq, and more. Bring your own API keys.",
    badge: "Default",
  },
  {
    name: "Cursor SDK",
    detail:
      "Run AI code review with Cursor models. Option for teams comparing Cursor Bugbot vs self-hosted review.",
    badge: null,
  },
];

export function Providers() {
  return (
    <section
      id="providers"
      aria-labelledby="providers-heading"
      className="border-t border-border-line"
      data-line
    >
      <div className="grid-layout py-16">
        <div className="col-span-4 md:col-span-12 lg:col-span-24">
          <h2 id="providers-heading" className="section-title mb-4">
            Bring your own AI model
          </h2>
          <p className="text-center text-foreground-secondary text-lg mb-10 max-w-2xl mx-auto">
            Unlike fixed-model SaaS reviewers, PR Agent lets you switch LLM providers without
            changing your GitHub review workflow.
          </p>
        </div>

        {providers.map((provider) => (
          <div
            key={provider.name}
            className="col-span-4 md:col-span-6 lg:col-span-12 border border-border-secondary rounded-xl p-6 bg-background-secondary"
          >
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-semibold text-foreground-primary">{provider.name}</h3>
              {provider.badge && (
                <span className="text-[10px] font-medium uppercase tracking-wider text-brand-base bg-brand-10 px-2 py-0.5 rounded-full">
                  {provider.badge}
                </span>
              )}
            </div>
            <p className="text-sm text-foreground-secondary leading-relaxed">{provider.detail}</p>
          </div>
        ))}

        <div className="col-span-4 md:col-span-12 lg:col-span-24 mt-6">
          <p className="text-sm text-foreground-muted text-center">
            See{" "}
            <a href="#usage" className="underline hover:text-foreground-secondary transition-colors duration-200">
              usage
            </a>{" "}
            or the repo README for setup.
          </p>
        </div>
      </div>
    </section>
  );
}
