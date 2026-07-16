import { DOCS_URL } from "@/lib/site";

export function Quickstart() {
  return (
    <section
      id="usage"
      aria-labelledby="usage-heading"
      className="bg-forge-raised px-4 py-20 sm:px-6 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <h2
          id="usage-heading"
          className="max-w-[18ch] font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-ink"
        >
          Deploy it with Docker Compose
        </h2>

        <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div className="space-y-8">
            <div>
              <h3 className="text-sm font-medium text-ink">1. Create a GitHub App</h3>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-mute">
                <li>
                  Webhook URL:{" "}
                  <code className="text-moss">https://&lt;host&gt;/webhooks</code>
                </li>
                <li>Events: pull requests and pull request comments</li>
                <li>Permissions: Issues and Pull requests read/write, Contents read</li>
              </ul>
              <p className="mt-3 text-sm text-ink-faint">
                Full deploy steps in the{" "}
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-soft underline decoration-edge-strong hover:text-ink"
                >
                  README Getting Started
                </a>
                .
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-ink">3. Ask in the PR thread</h3>
              <pre className="surface-inset edge-self mt-3 overflow-x-auto p-4 text-sm leading-relaxed text-ink-soft">
                <code>{`/review
/describe
/review-security
/review-quality
/ask Why is this function async?`}</code>
              </pre>
            </div>
          </div>

          <div className="space-y-8">
            <div>
              <h3 className="text-sm font-medium text-ink">2. Start the stack</h3>
              <pre className="surface-inset edge-self mt-3 overflow-x-auto p-4 text-sm leading-relaxed text-ink-soft">
                <code>{`cp .env.example .env
# Set GITHUB_*, WEBHOOK_SECRET, and provider API keys
docker compose build
docker compose up`}</code>
              </pre>
            </div>

            <div>
              <h3 className="text-sm font-medium text-ink">Minimal env</h3>
              <pre className="surface-inset edge-self mt-3 overflow-x-auto p-4 text-sm leading-relaxed text-ink-soft">
                <code>{`DATABASE_URL=...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
WEBHOOK_SECRET=...
AGENT_PROVIDER=pi
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...`}</code>
              </pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
