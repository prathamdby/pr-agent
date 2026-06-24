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
    trigger: "/ask &lt;question&gt;",
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
      className="section section-border"
    >
      <div className="container-geist">
        <div className="mx-auto max-w-2xl text-center mb-10">
          <h2 id="capabilities-heading" className="heading-32 mb-3">
            Everything You Need for PR Review
          </h2>
          <p className="copy-16 text-gray-900">
            Automated reviews, descriptions, security analysis, and Q&A — all triggered from GitHub
            comments or events.
          </p>
        </div>

        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((cap) => (
            <div key={cap.title} className="card card-compact">
              <h3 className="heading-16 mb-2">{cap.title}</h3>
              <p className="label-13 text-gray-700 mb-1">{cap.trigger}</p>
              <p className="copy-14 text-gray-900">{cap.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
