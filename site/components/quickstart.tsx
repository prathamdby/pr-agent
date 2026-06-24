import { DOCS_URL } from "@/lib/site";

const steps = [
  {
    title: "1. Create a GitHub App",
    type: "list" as const,
    items: [
      <>
        Webhook URL:{" "}
        <code className="font-mono text-brand-base">https://&lt;host&gt;/webhooks</code>
      </>,
      <>
        Events: <code className="font-mono text-brand-base">pull_request</code>,{" "}
        <code className="font-mono text-brand-base">issue_comment</code>,{" "}
        <code className="font-mono text-brand-base">pull_request_review_comment</code>
      </>,
      "Permissions: Issues and Pull requests read/write, Contents read",
    ],
    note: (
      <>
        Full steps in the{" "}
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-base hover:opacity-80 underline underline-offset-2"
        >
          README Getting Started
        </a>
        .
      </>
    ),
  },
  {
    title: "2. Docker Compose",
    type: "code" as const,
    code: `cp .env.example .env
# Set GITHUB_*, WEBHOOK_SECRET, and provider API keys
docker compose build
docker compose up`,
  },
  {
    title: "3. Slash commands",
    type: "code" as const,
    code: `/review
/describe
/review-security
/review-quality
/ask Why is this function async?`,
  },
  {
    title: "Minimal env",
    type: "code" as const,
    code: `DATABASE_URL=...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
WEBHOOK_SECRET=...
AGENT_PROVIDER=pi
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...`,
  },
];

export function Quickstart() {
  return (
    <section id="usage" aria-labelledby="usage-heading" data-line>
      <div className="grid-layout">
        <div className="grid-layout-inner py-16 md:py-20">
          <h2 id="usage-heading" className="section-title mb-3 text-foreground-primary">
            Deploy self-hosted AI code review
          </h2>
          <p className="mb-10 text-center text-foreground-secondary max-w-lg mx-auto">
            Three steps from clone to your first automated review.
          </p>

          <div className="mx-auto max-w-2xl space-y-6">
            {steps.map((step) => (
              <div key={step.title}>
                <h3 className="mb-2.5 text-base font-semibold text-foreground-primary">
                  {step.title}
                </h3>
                {step.type === "list" && (
                  <>
                    <ul className="space-y-1.5 text-sm text-foreground-secondary">
                      {step.items.map((item, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-base" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                    {"note" in step && step.note && (
                      <p className="mt-2.5 text-sm text-foreground-tertiary">{step.note}</p>
                    )}
                  </>
                )}
                {step.type === "code" && (
                  <pre
                    className="overflow-x-auto rounded-[10px] border border-border-line bg-background-secondary p-4 text-sm"
                    style={{ boxShadow: "var(--shadow-drop-sm)" }}
                  >
                    <code className="font-mono text-foreground-secondary">{step.code}</code>
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
