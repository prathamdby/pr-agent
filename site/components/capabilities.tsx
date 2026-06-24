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
    trigger: "/ask &lt;question&gt;",
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
      className="border-t border-border-line"
      data-line
    >
      <div className="grid-layout py-16">
        <div className="col-span-4 md:col-span-12 lg:col-span-24">
          <h2 id="capabilities-heading" className="section-title mb-10">
            GitHub pull request review features
          </h2>
        </div>

        {capabilities.map((cap) => (
          <div
            key={cap.title}
            className="col-span-4 md:col-span-6 lg:col-span-8 border border-border-secondary rounded-xl p-6 bg-background-primary hover:bg-background-secondary transition-colors duration-200"
          >
            <div className="size-8 rounded-lg bg-brand-10 flex items-center justify-center mb-3">
              <span className="size-2 rounded-full bg-brand-base" />
            </div>
            <h3 className="font-semibold text-foreground-primary mb-1">{cap.title}</h3>
            <p className="text-xs text-foreground-muted mb-2 font-mono">{cap.trigger}</p>
            <p className="text-sm text-foreground-secondary leading-relaxed">{cap.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
