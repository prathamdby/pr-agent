import { DOCS_URL } from "@/lib/site";

const steps = [
  {
    title: "Create a GitHub App",
    items: [
      "Webhook URL: https://<host>/webhooks",
      "Events: pull_request, issue_comment, pull_request_review_comment",
      "Permissions: Issues and Pull requests read/write, Contents read",
    ],
    note: "Full steps in the README Getting Started.",
    hasLink: true,
  },
  {
    title: "Docker Compose",
    code: `cp .env.example .env
# Set GITHUB_*, WEBHOOK_SECRET, and provider API keys
docker compose build
docker compose up`,
  },
  {
    title: "Slash Commands",
    code: `/review
/describe
/review-security
/review-quality
/ask Why is this function async?`,
  },
  {
    title: "Minimal Env",
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
    <section
      id="usage"
      aria-labelledby="usage-heading"
      className="border-t border-gray-alpha-200 bg-background-100 px-4 py-16 sm:px-6 sm:py-20 lg:px-8"
    >
      <div className="mx-auto max-w-[1200px]">
        <h2 id="usage-heading" className="text-heading-24 text-primary sm:text-heading-32">
          Deploy Self-Hosted AI Code Review
        </h2>
        <p className="mt-3 max-w-2xl text-copy-16 text-secondary">
          Run PR Agent on your own infrastructure in three steps.
        </p>

        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          {steps.map((step) => (
            <div
              key={step.title}
              className="rounded-md border border-gray-alpha-200 bg-background-100 p-6 shadow-card"
            >
              <h3 className="text-heading-16 text-primary">{step.title}</h3>
              {step.items && (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-copy-14 text-secondary">
                  {step.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {step.code && (
                <pre className="mt-3 overflow-x-auto rounded-sm border border-gray-alpha-200 bg-background-200 p-4 text-copy-13-mono text-primary">
                  <code>{step.code}</code>
                </pre>
              )}
              {step.note && (
                <p className="mt-3 text-copy-14 text-gray-700">
                  {step.hasLink ? (
                    <>
                      {step.note.split("README Getting Started")[0]}
                      <a
                        href={DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-tertiary underline hover:text-blue-800"
                      >
                        README Getting Started
                      </a>
                      {step.note.split("README Getting Started")[1]}
                    </>
                  ) : (
                    step.note
                  )}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
