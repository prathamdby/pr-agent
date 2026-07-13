const capabilities = [
  {
    title: "One synthesized Review summary per Review run",
    trigger: "Runs when a PR opens (REVIEW_AUTO_ACTIONS default), or when you comment /review",
    detail:
      "Multi-agent Reviewer reports are validated and synthesized into one Review summary comment—not separate lens products.",
  },
  {
    title: "Turn a blank PR body into a readable summary",
    trigger: "Runs when a PR opens, or when you comment /describe",
    detail: "Summary bullets and an optional diagram go into the PR body.",
  },
  {
    title: "Verification on follow-up commits, not a full re-review",
    trigger:
      "Runs on synchronize by default (VERIFICATION_AUTO_ACTIONS); full Review needs /review",
    detail:
      "A Verification run re-checks open findings against the new head. Follow-up pushes do not re-run a full Review run unless you add synchronize to REVIEW_AUTO_ACTIONS or comment /review.",
  },
  {
    title: "Close the loop with Triage and repo policy",
    trigger: "Comment /triage on the PR or inside an inline finding thread",
    detail:
      "A Triage run can autofix eligible findings (Contents write required) and suggest repo policy snippets for dismissed patterns.",
  },
  {
    title: "Ask code questions without leaving GitHub",
    trigger: "Comment /ask followed by your question",
    detail: "Get an answer in the same thread, right where the code lives.",
  },
  {
    title: "Skip a full Review run when the PR is only docs",
    trigger: "Lightweight review completion on docs-only trivial changes",
    detail:
      "Docs-only pull requests can finish with a short notice instead of a full multi-agent Review run.",
  },
];

export function Capabilities() {
  return (
    <section
      id="capabilities"
      aria-labelledby="capabilities-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="capabilities-heading" className="text-xl mb-4">
          What your team gets back in GitHub
        </h2>

        <ul className="space-y-4">
          {capabilities.map((cap) => (
            <li key={cap.title} className="text-sm">
              <h3 className="font-medium text-neutral-800">{cap.title}</h3>
              <p className="text-neutral-500">{cap.trigger}</p>
              <p className="text-neutral-600 mt-0.5">{cap.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
