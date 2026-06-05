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
    <section
      id="providers"
      aria-labelledby="providers-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="providers-heading" className="text-xl mb-4">
          Bring your own AI model
        </h2>

        <ul className="space-y-3 text-sm">
          {providers.map((provider) => (
            <li key={provider.name}>
              <h3 className="font-medium text-neutral-800">{provider.name}</h3>
              <p className="text-neutral-600">{provider.detail}</p>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-sm text-neutral-500">
          Unlike fixed-model SaaS reviewers, PR Agent lets you switch LLM
          providers without changing your GitHub review workflow. See{" "}
          <a href="#usage" className="underline hover:text-neutral-700">
            usage
          </a>{" "}
          or the repo README for setup.
        </p>
      </div>
    </section>
  );
}
