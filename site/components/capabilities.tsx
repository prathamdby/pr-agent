const capabilities = [
  {
    title: "Catch review basics before a human opens the diff",
    trigger: "Runs when a PR opens or updates, or when you comment /review",
    detail: "Inline comments appear on the Files changed tab.",
  },
  {
    title: "Turn a blank PR body into a readable summary",
    trigger: "Runs when a PR opens, or when you comment /describe",
    detail: "Summary bullets and an optional diagram go into the PR body.",
  },
  {
    title: "Ask for a security pass when the change touches risk",
    trigger: "Comment /review-security on the PR",
    detail: "Security notes are posted as a separate summary.",
  },
  {
    title: "Ask for a quality pass before merge",
    trigger: "Comment /review-quality on the PR",
    detail: "Maintainability notes land in the PR conversation.",
  },
  {
    title: "Ask code questions without leaving GitHub",
    trigger: "Comment /ask followed by your question",
    detail: "Get an answer in the same thread, right where the code lives.",
  },
  {
    title: "Skip AI review when the PR is only docs",
    trigger: "Runs automatically on small documentation-only changes",
    detail: "Docs-only pull requests take a lighter path instead of a full review.",
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
