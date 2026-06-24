import { DOCS_URL } from "@/lib/site";

export function Quickstart() {
  return (
    <section
      id="usage"
      aria-labelledby="usage-heading"
      className="border-t border-border-line"
      data-line
    >
      <div className="grid-layout py-16">
        <div className="col-span-4 md:col-span-12 lg:col-span-24">
          <h2 id="usage-heading" className="section-title mb-4">
            Deploy self-hosted AI code review
          </h2>
          <p className="text-center text-foreground-secondary text-lg mb-10 max-w-2xl mx-auto">
            Get PR Agent running on your infrastructure in minutes with Docker Compose.
          </p>
        </div>

        {/* Step 1 */}
        <div className="col-span-4 md:col-span-6 lg:col-span-12 mb-6 lg:mb-0">
          <div className="border border-border-secondary rounded-xl p-6 bg-background-secondary h-full">
            <div className="flex items-center gap-3 mb-4">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-base text-xs font-bold text-white">
                1
              </span>
              <h3 className="font-semibold text-foreground-primary">Create a GitHub App</h3>
            </div>
            <ul className="text-sm text-foreground-secondary space-y-2">
              <li>
                <span className="text-foreground-muted">Webhook URL:</span>{" "}
                <code className="font-mono text-xs bg-background-tertiary px-1.5 py-0.5 rounded">
                  https://&lt;host&gt;/webhooks
                </code>
              </li>
              <li>
                <span className="text-foreground-muted">Events:</span>{" "}
                <code className="font-mono text-xs bg-background-tertiary px-1.5 py-0.5 rounded">
                  pull_request
                </code>
                ,{" "}
                <code className="font-mono text-xs bg-background-tertiary px-1.5 py-0.5 rounded">
                  issue_comment
                </code>
                ,{" "}
                <code className="font-mono text-xs bg-background-tertiary px-1.5 py-0.5 rounded">
                  pull_request_review_comment
                </code>
              </li>
              <li>
                <span className="text-foreground-muted">Permissions:</span> Issues and Pull
                requests read/write, Contents read
              </li>
            </ul>
            <p className="mt-3 text-sm text-foreground-muted">
              Full steps in the{" "}
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground-secondary transition-colors duration-200"
              >
                README Getting Started
              </a>
              .
            </p>
          </div>
        </div>

        {/* Step 2 */}
        <div className="col-span-4 md:col-span-6 lg:col-span-12 mb-6 lg:mb-0">
          <div className="border border-border-secondary rounded-xl p-6 bg-background-secondary h-full">
            <div className="flex items-center gap-3 mb-4">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-base text-xs font-bold text-white">
                2
              </span>
              <h3 className="font-semibold text-foreground-primary">Docker Compose</h3>
            </div>
            <pre className="bg-background-primary border border-border-secondary rounded-lg p-4 text-sm overflow-x-auto">
              <code className="text-foreground-secondary font-mono text-xs">
                {`cp .env.example .env
# Set GITHUB_*, WEBHOOK_SECRET,
# and provider API keys
docker compose build
docker compose up`}
              </code>
            </pre>
          </div>
        </div>

        {/* Step 3 */}
        <div className="col-span-4 md:col-span-6 lg:col-span-12">
          <div className="border border-border-secondary rounded-xl p-6 bg-background-secondary h-full">
            <div className="flex items-center gap-3 mb-4">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-base text-xs font-bold text-white">
                3
              </span>
              <h3 className="font-semibold text-foreground-primary">Slash commands</h3>
            </div>
            <pre className="bg-background-primary border border-border-secondary rounded-lg p-4 text-sm overflow-x-auto">
              <code className="text-foreground-secondary font-mono text-xs">
                {`/review
/describe
/review-security
/review-quality
/ask Why is this function async?`}
              </code>
            </pre>
          </div>
        </div>

        {/* Env snippet */}
        <div className="col-span-4 md:col-span-6 lg:col-span-12">
          <div className="border border-border-secondary rounded-xl p-6 bg-background-secondary h-full">
            <div className="flex items-center gap-3 mb-4">
              <span className="flex size-7 items-center justify-center rounded-full bg-orange text-xs font-bold text-white">
                *
              </span>
              <h3 className="font-semibold text-foreground-primary">Minimal env</h3>
            </div>
            <pre className="bg-background-primary border border-border-secondary rounded-lg p-4 text-sm overflow-x-auto">
              <code className="text-foreground-secondary font-mono text-xs">
                {`DATABASE_URL=...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
WEBHOOK_SECRET=...
AGENT_PROVIDER=pi
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...`}
              </code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
