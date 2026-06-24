const providers = [
  {
    name: "Pi (default)",
    detail:
      "OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Groq, and more. Bring your own API keys.",
  },
  {
    name: "Cursor SDK",
    detail:
      "Run AI code review with Cursor models. Option for teams comparing Cursor Bugbot vs self-hosted review.",
  },
];

export function Providers() {
  return (
    <section id="providers" aria-labelledby="providers-heading" data-line>
      <div className="grid-layout">
        <div className="grid-layout-inner py-16 md:py-20">
          <h2 id="providers-heading" className="section-title mb-3 text-foreground-primary">
            Bring your own AI model
          </h2>
          <p className="mb-10 text-center text-foreground-secondary max-w-lg mx-auto">
            Switch LLM providers without changing your GitHub review workflow.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {providers.map((provider) => (
              <div
                key={provider.name}
                className="rounded-[10px] border border-border-line bg-background-secondary p-6"
                style={{ boxShadow: "var(--shadow-drop-sm)" }}
              >
                <h3 className="text-base font-semibold text-foreground-primary">{provider.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
                  {provider.detail}
                </p>
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-sm text-foreground-tertiary max-w-lg mx-auto">
            Unlike fixed-model SaaS reviewers, PR Agent lets you switch LLM providers without
            changing your GitHub review workflow. See{" "}
            <a
              href="#usage"
              className="text-brand-base hover:opacity-80 underline underline-offset-2"
            >
              usage
            </a>{" "}
            or the repo README for setup.
          </p>
        </div>
      </div>
    </section>
  );
}
