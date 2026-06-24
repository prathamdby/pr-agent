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
      className="border-t border-gray-alpha-200 bg-background-200 px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2 id="providers-heading" className="text-heading-24 text-primary sm:text-heading-32">
          Bring Your Own AI Model
        </h2>
        <p className="mt-3 max-w-2xl text-copy-16 text-secondary">
          Unlike fixed-model SaaS reviewers, PR Agent lets you switch LLM providers without changing
          your GitHub review workflow.
        </p>

        <ul className="mt-10 grid gap-4 sm:grid-cols-2">
          {providers.map((provider) => (
            <li
              key={provider.name}
              className="rounded-md border border-gray-alpha-200 bg-background-100 p-6 shadow-card"
            >
              <h3 className="text-heading-16 text-primary">{provider.name}</h3>
              <p className="mt-2 text-copy-14 text-secondary">{provider.detail}</p>
            </li>
          ))}
        </ul>

        <p className="mt-6 text-copy-14 text-gray-700">
          See{" "}
          <a href="#usage" className="text-tertiary underline hover:text-blue-800">
            Usage
          </a>{" "}
          or the repo README for setup.
        </p>
      </div>
    </section>
  );
}
