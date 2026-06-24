const providers = [
  {
    name: "Pi (Default)",
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
    <section id="providers" aria-labelledby="providers-heading" className="section section-border">
      <div className="container-geist">
        <div className="mx-auto max-w-2xl text-center mb-10">
          <h2 id="providers-heading" className="heading-32 mb-3">
            Bring Your Own AI Model
          </h2>
          <p className="copy-16 text-gray-900">
            Unlike fixed-model SaaS reviewers, PR Agent lets you switch LLM providers without
            changing your GitHub review workflow.
          </p>
        </div>

        <div className="mx-auto grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
          {providers.map((provider) => (
            <div key={provider.name} className="card">
              <h3 className="heading-16 mb-2">{provider.name}</h3>
              <p className="copy-14 text-gray-900">{provider.detail}</p>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-8 max-w-2xl text-center">
          <p className="copy-14 text-gray-700">
            See the{" "}
            <a href="#usage" className="text-gray-1000">
              usage
            </a>{" "}
            section or the repo README for setup.
          </p>
        </div>
      </div>
    </section>
  );
}
