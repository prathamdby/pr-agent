const capabilities = [
  {
    title: "AI Code Reviews",
    trigger: "Auto on PR open and sync, or /review",
    detail: "Automated pull request review with inline comments on the Files changed tab.",
  },
  {
    title: "PR Descriptions",
    trigger: "Auto on PR open, or /describe",
    detail: "AI-generated summary bullets and optional diagram merged into the PR body.",
  },
  {
    title: "Security Reviews",
    trigger: "/review-security",
    detail: "Security-focused code review as a separate summary on the pull request.",
  },
  {
    title: "Quality Reviews",
    trigger: "/review-quality",
    detail: "Code quality and maintainability review on demand.",
  },
  {
    title: "Q&A on PRs",
    trigger: "/ask <question>",
    detail: "Ask questions about PR code from the conversation or an inline diff thread.",
  },
  {
    title: "Docs-Only Fast Path",
    trigger: "Auto on trivial doc-only PRs",
    detail: "Skips full AI review when every changed file is documentation.",
  },
];

export function Capabilities() {
  return (
    <section
      id="capabilities"
      aria-labelledby="capabilities-heading"
      className="border-t border-gray-alpha-200 bg-background-200 px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2 id="capabilities-heading" className="text-heading-24 text-primary sm:text-heading-32">
          GitHub Pull Request Review Features
        </h2>
        <p className="mt-3 max-w-2xl text-copy-16 text-secondary">
          Automated workflows and slash commands for every review task.
        </p>

        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((cap) => (
            <li
              key={cap.title}
              className="rounded-md border border-gray-alpha-200 bg-background-100 p-6 shadow-card"
            >
              <h3 className="text-heading-16 text-primary">{cap.title}</h3>
              <p className="mt-1 text-label-13-mono text-tertiary">{cap.trigger}</p>
              <p className="mt-2 text-copy-14 text-secondary">{cap.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
