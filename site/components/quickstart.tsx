import { DOCS_URL } from "@/lib/site";

export function Quickstart() {
  return (
    <section
      id="usage"
      aria-labelledby="usage-heading"
      className="px-4 py-8 border-t border-neutral-100"
    >
      <div className="mx-auto max-w-xl">
        <h2 id="usage-heading" className="text-xl mb-4">
          Deploy it with Docker Compose
        </h2>

        <div className="space-y-6">
          <div>
            <h3 className="text-sm font-medium text-neutral-800 mb-2">1. Create a GitHub App</h3>
            <ul className="text-sm text-neutral-600 space-y-1 list-disc list-inside">
              <li>
                Webhook URL: <code>https://&lt;host&gt;/webhooks</code>
              </li>
              <li>Events: pull requests and pull request comments</li>
              <li>Permissions: Issues and Pull requests read/write, Contents read</li>
            </ul>
            <p className="mt-2 text-sm text-neutral-500">
              Full deploy steps in the{" "}
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-neutral-700"
              >
                README Getting Started
              </a>
              .
            </p>
          </div>

          <div>
            <h3 className="text-sm font-medium text-neutral-800 mb-2">2. Start the stack</h3>
            <pre className="bg-neutral-50 border border-neutral-200 rounded p-3 text-sm overflow-x-auto">
              <code className="text-neutral-700">
                {`cp .env.example .env
# Set GITHUB_*, WEBHOOK_SECRET, and provider API keys
docker compose build
docker compose up`}
              </code>
            </pre>
          </div>

          <div>
            <h3 className="text-sm font-medium text-neutral-800 mb-2">3. Ask in the PR thread</h3>
            <pre className="bg-neutral-50 border border-neutral-200 rounded p-3 text-sm overflow-x-auto">
              <code className="text-neutral-700">
                {`/review
/describe
/review-security
/review-quality
/ask Why is this function async?`}
              </code>
            </pre>
          </div>

          <div>
            <h3 className="text-sm font-medium text-neutral-800 mb-2">Minimal env</h3>
            <pre className="bg-neutral-50 border border-neutral-200 rounded p-3 text-sm overflow-x-auto">
              <code className="text-neutral-700">
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
