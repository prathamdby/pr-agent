export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="features-heading" className="text-xl mb-4">
          How AI code review works on PR Agent
        </h2>

        <div className="space-y-4 text-sm text-neutral-600">
          <p>
            <strong className="text-neutral-800">Fast intake.</strong> GitHub
            webhooks are verified, deduplicated, and enqueued in Postgres before
            the HTTP response returns. A review backlog does not block webhook
            acceptance.
          </p>

          <p>
            <strong className="text-neutral-800">Self-hosted.</strong> You run
            the web intake and worker processes on your infrastructure. Postgres,
            pg-boss, and GitHub App credentials stay under your control.
          </p>

          <p>
            <strong className="text-neutral-800">AI on pull requests.</strong>{" "}
            Workers clone the PR head, run an AI investigation pass, and publish
            structured reviews, descriptions, and answers back to GitHub.
          </p>

          <p>
            <strong className="text-neutral-800">Slash commands.</strong> Trigger
            reviews, descriptions, and Q&A from PR comments with{" "}
            <code>/review</code>, <code>/describe</code>, <code>/ask</code>, and
            more.
          </p>

          <p>
            <strong className="text-neutral-800">Large PRs.</strong> File listing
            and patch caps keep runs bounded. Truncation is explicit when the
            change set is clipped.
          </p>
        </div>
      </div>
    </section>
  );
}
