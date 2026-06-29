const capabilities = [
  {
    title: "Catch review basics before a human opens the diff",
    trigger: "Auto on PR open and sync, or /review",
    detail: "PR Agent posts inline comments on the Files changed tab.",
  },
  {
    title: "Turn a blank PR body into a readable summary",
    trigger: "Auto on PR open, or /describe",
    detail: "Summary bullets and an optional diagram go into the PR body.",
  },
  {
    title: "Ask for a security pass when the change touches risk",
    trigger: "/review-security",
    detail: "Security notes are posted as a separate PR summary.",
  },
  {
    title: "Ask for a quality pass before merge",
    trigger: "/review-quality",
    detail: "Maintainability notes land in the PR conversation.",
  },
  {
    title: "Ask code questions without leaving GitHub",
    trigger: "/ask <question>",
    detail: "Comment /ask why is this function async and get an answer in the thread.",
  },
  {
    title: "Skip AI review when the PR is only docs",
    trigger: "Auto on trivial doc-only PRs",
    detail: "Docs-only changes take the short path instead of a full review run.",
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
