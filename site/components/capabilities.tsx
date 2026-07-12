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
    title: "Review every change from multiple angles",
    trigger: "Runs automatically or when you comment /review",
    detail: "Correctness, security, tests, reliability, and maintainability are synthesized once.",
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
