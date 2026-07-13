const capabilities = [
  {
    title: "One multi-agent Review run under /review",
    trigger: "Runs when a PR opens (REVIEW_AUTO_ACTIONS default), or when you comment /review",
    detail:
      "Eight reviewer agents synthesize into one Review summary comment—not four separate lens products.",
  },
  {
    title: "Turn a blank PR body into a readable summary",
    trigger: "Runs when a PR opens, or when you comment /describe",
    detail: "Summary bullets and an optional diagram go into the PR body.",
  },
  {
    title: "Verification on follow-up commits",
    trigger:
      "Runs on synchronize by default (VERIFICATION_AUTO_ACTIONS)—not a full Review run on every push",
    detail:
      "A Verification run re-checks open PR Agent findings against the new head; it does not open new findings.",
  },
  {
    title: "Triage autofix and repo policy as the resolution loop",
    trigger: "Comment /triage on the PR or in an inline finding thread",
    detail:
      "A Triage run fixes valid same-repo findings and pushes commits; dismissals can draft .pr-agent.yml policy suggestions.",
  },
  {
    title: "Ask code questions without leaving GitHub",
    trigger: "Comment /ask followed by your question",
    detail: "Get an answer in the same thread, right where the code lives.",
  },
  {
    title: "Skip AI review when the PR is only docs",
    trigger: "Lightweight review completion on docs-only automated reviews",
    detail:
      "Documentation-only change sets take a lighter path instead of a full Review run (slash /review still runs fully).",
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
