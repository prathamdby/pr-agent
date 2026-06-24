import { DOCS_URL } from "@/lib/site";

export function Quickstart() {
  return (
    <section id="usage" aria-labelledby="usage-heading" className="section section-border">
      <div className="container-geist">
        <div className="mx-auto max-w-2xl">
          <h2 id="usage-heading" className="heading-32 mb-10 text-center">
            Deploy Self-Hosted AI Code Review
          </h2>

          <div className="space-y-8">
            <div className="card">
              <h3 className="heading-16 mb-2">1. Create a GitHub App</h3>
              <ul className="copy-14 text-gray-900 space-y-1 list-disc list-inside mb-3">
                <li>
                  Webhook URL: <code>https://&lt;host&gt;/webhooks</code>
                </li>
                <li>
                  Events: <code>pull_request</code>, <code>issue_comment</code>,{" "}
                  <code>pull_request_review_comment</code>
                </li>
                <li>Permissions: Issues and Pull requests read/write, Contents read</li>
              </ul>
              <p className="copy-14 text-gray-700">
                Full steps in the{" "}
                <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
                  README Getting Started
                </a>
                .
              </p>
            </div>

            <div className="card">
              <h3 className="heading-16 mb-2">2. Docker Compose</h3>
              <pre className="code-block mt-3">
                <code>{`cp .env.example .env
# Set GITHUB_*, WEBHOOK_SECRET, and provider API keys
docker compose build
docker compose up`}</code>
              </pre>
            </div>

            <div className="card">
              <h3 className="heading-16 mb-2">3. Slash Commands</h3>
              <pre className="code-block mt-3">
                <code>{`/review
/describe
/review-security
/review-quality
/ask Why is this function async?`}</code>
              </pre>
            </div>

            <div className="card">
              <h3 className="heading-16 mb-2">4. Minimal Env Config</h3>
              <pre className="code-block mt-3">
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
