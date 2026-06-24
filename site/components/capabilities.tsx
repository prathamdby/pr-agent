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
    <section id="capabilities" aria-labelledby="capabilities-heading" data-line>
      <div className="grid-layout">
        <div className="grid-layout-inner py-16 md:py-20">
          <h2 id="capabilities-heading" className="section-title mb-3 text-foreground-primary">
            GitHub pull request review features
          </h2>
          <p className="mb-10 text-center text-foreground-secondary max-w-lg mx-auto">
            Six slash-command capabilities covering the full review lifecycle.
          </p>

          <div className="grid gap-px overflow-hidden rounded-[10px] border border-border-line bg-border-line sm:grid-cols-2 lg:grid-cols-3">
            {capabilities.map((cap) => (
              <div
                key={cap.title}
                className="bg-background-secondary p-6 transition-colors duration-200 hover:bg-background-tertiary"
                style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
              >
                <h3 className="text-base font-semibold text-foreground-primary">{cap.title}</h3>
                <p className="mt-1 font-mono text-xs text-brand-base">{cap.trigger}</p>
                <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
                  {cap.detail}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
