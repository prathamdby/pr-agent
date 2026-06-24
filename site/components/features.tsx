const features = [
  {
    title: "Fast Intake",
    description:
      "GitHub webhooks are verified, deduplicated, and enqueued in Postgres before the HTTP response returns. A review backlog does not block webhook acceptance.",
  },
  {
    title: "Self-Hosted",
    description:
      "You run the web intake and worker processes on your infrastructure. Postgres, pg-boss, and GitHub App credentials stay under your control.",
  },
  {
    title: "AI on Pull Requests",
    description:
      "Workers clone the PR head, run an AI investigation pass, and publish structured reviews, descriptions, and answers back to GitHub.",
  },
  {
    title: "Slash Commands",
    description:
      "Trigger reviews, descriptions, and Q&A from PR comments with /review, /describe, /ask, and more.",
  },
  {
    title: "Large PRs",
    description:
      "File listing and patch caps keep runs bounded. Truncation is explicit when the change set is clipped.",
  },
  {
    title: "Bring Your Own Model",
    description:
      "Switch LLM providers without changing your GitHub review workflow. Pi and Cursor SDK are supported today.",
  },
];

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="border-t border-gray-alpha-200 bg-background-100 px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2 id="features-heading" className="text-heading-24 text-primary sm:text-heading-32">
          How AI Code Review Works on PR Agent
        </h2>
        <p className="mt-3 max-w-2xl text-copy-16 text-secondary">
          Fast, self-hosted, and model-agnostic review pipeline for GitHub pull requests.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-md border border-gray-alpha-200 bg-background-100 p-6 shadow-card"
            >
              <h3 className="text-heading-16 text-primary">{feature.title}</h3>
              <p className="mt-2 text-copy-14 text-secondary">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
