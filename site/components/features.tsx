const features = [
  {
    title: "Fast intake",
    detail:
      "GitHub webhooks are verified, deduplicated, and enqueued in Postgres before the HTTP response returns. A review backlog does not block webhook acceptance.",
  },
  {
    title: "Self-hosted",
    detail:
      "You run the web intake and worker processes on your infrastructure. Postgres, pg-boss, and GitHub App credentials stay under your control.",
  },
  {
    title: "AI on pull requests",
    detail:
      "Workers clone the PR head, run an AI investigation pass, and publish structured reviews, descriptions, and answers back to GitHub.",
  },
  {
    title: "Slash commands",
    detail:
      "Trigger reviews, descriptions, and Q&A from PR comments with /review, /describe, /ask, and more.",
  },
  {
    title: "Large PRs",
    detail:
      "File listing and patch caps keep runs bounded. Truncation is explicit when the change set is clipped.",
  },
];

export function Features() {
  return (
    <section id="features" aria-labelledby="features-heading" data-line>
      <div className="grid-layout">
        <div className="grid-layout-inner py-16 md:py-20">
          <h2 id="features-heading" className="section-title mb-3 text-foreground-primary">
            How AI code review works on PR Agent
          </h2>
          <p className="mb-10 text-center text-foreground-secondary max-w-lg mx-auto">
            A durable pipeline from webhook to published review — entirely on your infrastructure.
          </p>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div
                key={f.title}
                className="rounded-[10px] border border-border-line bg-background-secondary p-6 transition-shadow duration-200 hover:bg-background-tertiary"
                style={{
                  boxShadow: "var(--shadow-feature-card)",
                  transitionTimingFunction: "var(--ease-out-soft)",
                }}
              >
                <h3 className="mb-2 text-base font-semibold text-foreground-primary">{f.title}</h3>
                <p className="text-sm leading-relaxed text-foreground-secondary">{f.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
