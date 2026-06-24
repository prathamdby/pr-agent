const features = [
  {
    title: "Fast intake",
    body: "GitHub webhooks are verified, deduplicated, and enqueued in Postgres before the HTTP response returns. A review backlog does not block webhook acceptance.",
  },
  {
    title: "Self-hosted",
    body: "You run the web intake and worker processes on your infrastructure. Postgres, pg-boss, and GitHub App credentials stay under your control.",
  },
  {
    title: "AI on pull requests",
    body: "Workers clone the PR head, run an AI investigation pass, and publish structured reviews, descriptions, and answers back to GitHub.",
  },
  {
    title: "Slash commands",
    body: 'Trigger reviews, descriptions, and Q&A from PR comments with <code>/review</code>, <code>/describe</code>, <code>/ask</code>, and more.',
  },
  {
    title: "Large PRs",
    body: "File listing and patch caps keep runs bounded. Truncation is explicit when the change set is clipped.",
  },
];

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="border-t border-border-line"
      data-line
    >
      <div className="grid-layout py-16">
        <div className="col-span-4 md:col-span-12 lg:col-span-24">
          <h2 id="features-heading" className="section-title mb-4">
            How AI code review works on PR Agent
          </h2>
          <p className="text-center text-foreground-secondary text-lg mb-10 max-w-2xl mx-auto">
            Every piece of the pipeline—from incoming webhook to published review—is designed
            for reliability, control, and transparency.
          </p>
        </div>

        {features.map((feature) => (
          <div
            key={feature.title}
            className="col-span-4 md:col-span-6 lg:col-span-8 rounded-xl border border-border-secondary bg-background-secondary p-6 transition-all duration-200 hover:shadow-feature-card hover:-translate-y-0.5"
          >
            <h3 className="font-semibold text-foreground-primary mb-2 text-base">
              {feature.title}
            </h3>
            <p
              className="text-sm text-foreground-secondary leading-relaxed"
              dangerouslySetInnerHTML={{ __html: feature.body }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
