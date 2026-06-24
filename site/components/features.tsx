const features = [
  {
    title: "Fast Intake",
    description:
      "GitHub webhooks are verified, deduplicated, and enqueued in Postgres before the HTTP response returns. A review backlog does not block webhook acceptance.",
  },
  {
    title: "Self-Hosted",
    description:
      "Web intake and worker processes run on your infrastructure. Postgres, pg-boss, and GitHub App credentials stay under your control.",
  },
  {
    title: "AI on Pull Requests",
    description:
      "Workers clone the PR head, run an AI investigation pass, and publish structured reviews, descriptions, and answers back to GitHub.",
  },
  {
    title: "Slash Commands",
    description:
      "Trigger reviews, descriptions, and Q&A from PR comments with <code>/review</code>, <code>/describe</code>, <code>/ask</code>, and more.",
  },
  {
    title: "Large PR Support",
    description:
      "File listing and patch caps keep runs bounded. Truncation is explicit when the change set is clipped.",
  },
];

export function Features() {
  return (
    <section id="features" aria-labelledby="features-heading" className="section section-border">
      <div className="container-geist">
        <div className="mx-auto max-w-2xl text-center mb-10">
          <h2 id="features-heading" className="heading-32 mb-3">
            How AI Code Review Works
          </h2>
          <p className="copy-16 text-gray-900">
            PR Agent is a full review platform you deploy yourself — from webhook intake to AI
            investigation to publishing back on GitHub.
          </p>
        </div>

        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2">
          {features.map((feature) => (
            <div key={feature.title} className="card">
              <h3 className="heading-16 mb-2">{feature.title}</h3>
              <p
                className="copy-14 text-gray-900"
                dangerouslySetInnerHTML={{ __html: feature.description }}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
