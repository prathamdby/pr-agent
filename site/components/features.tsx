export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="features-heading" className="text-xl mb-4">
          Stop burning reviewer time on repeat checks
        </h2>

        <div className="space-y-4 text-sm text-neutral-600">
          <p>
            <strong className="text-neutral-800">3 GitHub events go into one queue.</strong> PR
            Agent accepts <code>pull_request</code>, <code>issue_comment</code>, and{" "}
            <code>pull_request_review_comment</code> webhooks, verifies them, and stores jobs in
            Postgres.
          </p>

          <p>
            <strong className="text-neutral-800">2 processes do the work.</strong> A web process
            takes GitHub traffic. A worker process clones the PR, runs the AI pass, and publishes
            back to GitHub.
          </p>

          <p>
            <strong className="text-neutral-800">1 place to read results.</strong> Reviews,
            descriptions, security notes, quality notes, and answers land in the pull request where
            the discussion already lives.
          </p>

          <p>
            <strong className="text-neutral-800">5 commands cover the common asks.</strong> Use{" "}
            <code>/review</code>, <code>/describe</code>, <code>/review-security</code>,{" "}
            <code>/review-quality</code>, and <code>/ask</code> from PR comments.
          </p>

          <p>
            <strong className="text-neutral-800">Big PRs show their limits.</strong> File listing
            and patch caps bound each run. When a diff is clipped, PR Agent says so.
          </p>
        </div>
      </div>
    </section>
  );
}
