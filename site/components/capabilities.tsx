const capabilities = [
  {
    title: "AI code reviews",
    trigger: "Auto on PR open and sync, or /review",
    detail: "Automated pull request review with inline comments on the Files changed tab.",
  },
  {
    title: "PR descriptions",
    trigger: "Auto on PR open, or /describe",
    detail: "AI-generated summary bullets and optional diagram merged into the PR body.",
  },
  {
    title: "Security reviews",
    trigger: "/review-security",
    detail: "Security-focused code review as a separate summary on the pull request.",
  },
  {
    title: "Quality reviews",
    trigger: "/review-quality",
    detail: "Code quality and maintainability review on demand.",
  },
  {
    title: "Q&A on PRs",
    trigger: "/ask <question>",
    detail: "Ask questions about PR code from the conversation or an inline diff thread.",
  },
  {
    title: "Docs-only fast path",
    trigger: "Auto on trivial doc-only PRs",
    detail: "Skips full AI review when every changed file is documentation.",
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
          GitHub pull request review features
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
