import { Section } from "@/components/section";
import { DOCS_URL } from "@/lib/site";

const APP_FIELDS = [
  {
    label: "Webhook URL",
    value: "https://<host>/webhooks",
    mono: true,
  },
  {
    label: "Subscribe to",
    value: "Pull requests · Issue comments · Pull request review comments",
    mono: false,
  },
  {
    label: "Permissions",
    value: "Issues and Pull requests: read/write · Contents: read/write · Metadata: read",
    mono: false,
  },
] as const;

const SLASH_COMMANDS = [
  { cmd: "/review", tip: "Run a full review on the changes" },
  { cmd: "/describe", tip: "Write a readable summary into the PR body" },
  { cmd: "/ask …", tip: "Ask a question about the code in that thread" },
  { cmd: "/triage", tip: "Recheck earlier findings and fix valid ones" },
] as const;

const COMPOSE_SNIPPET = `cp .env.example .env
# Fill GITHUB_*, WEBHOOK_SECRET, and your provider key
docker compose build
docker compose up`;

const ENV_SNIPPET = `DATABASE_URL=postgres://...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
WEBHOOK_SECRET=...
AGENT_PROVIDER=pi
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...`;

function StepNumber({ n }: { readonly n: string }) {
  return (
    <p
      aria-hidden="true"
      className="font-display text-[clamp(2.5rem,5vw,3.5rem)] leading-none tracking-[-0.03em] text-sky/45"
    >
      {n}
    </p>
  );
}

function CodeBlock({ children }: { readonly children: string }) {
  return (
    <pre className="surface-inset edge-self mt-5 overflow-x-auto rounded-md p-4 text-sm leading-relaxed text-ink-soft sm:p-5">
      <code>{children}</code>
    </pre>
  );
}

export function Quickstart() {
  return (
    <Section id="usage" labelledBy="usage-heading" raised>
      <header className="max-w-2xl">
        <h2
          id="usage-heading"
          className="font-display text-[clamp(2.1rem,4.2vw,3.25rem)] leading-[1.05] tracking-[-0.02em] text-ink"
        >
          Deploy it with Docker Compose
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ink-mute sm:text-[1.05rem]">
          Three steps from an empty machine to a review on a real pull request. You need Docker, a
          GitHub app, and one AI provider key.
        </p>
      </header>

      <ol className="mt-12 border-t border-edge">
        <li className="grid gap-3 border-b border-edge py-10 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-8 sm:py-12 md:grid-cols-[5.5rem_minmax(0,1fr)]">
          <StepNumber n="01" />
          <div className="min-w-0 max-w-2xl">
            <h3 className="text-lg font-medium leading-snug text-ink sm:text-xl">
              Create a GitHub app
            </h3>
            <p className="mt-2 text-[0.98rem] leading-relaxed text-ink-mute sm:text-base">
              Register the app on your account or org, then point GitHub at the host where you will
              run PR Agent.
            </p>
            <dl className="mt-6 space-y-4">
              {APP_FIELDS.map((field) => (
                <div key={field.label}>
                  <dt className="text-xs font-medium text-ink-faint">{field.label}</dt>
                  <dd
                    className={
                      field.mono
                        ? "mt-1 font-mono text-sm text-bolt"
                        : "mt-1 text-sm leading-relaxed text-ink-soft"
                    }
                  >
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-5 text-sm leading-relaxed text-ink-faint">
              Need the click-by-click path? See{" "}
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-soft underline decoration-edge-strong hover:text-ink"
              >
                README Host with Docker Compose
              </a>
              .
            </p>
          </div>
        </li>

        <li className="grid gap-3 border-b border-edge py-10 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-8 sm:py-12 md:grid-cols-[5.5rem_minmax(0,1fr)]">
          <StepNumber n="02" />
          <div className="min-w-0 max-w-2xl">
            <h3 className="text-lg font-medium leading-snug text-ink sm:text-xl">
              Fill .env and start the stack
            </h3>
            <p className="mt-2 text-[0.98rem] leading-relaxed text-ink-mute sm:text-base">
              Copy the example env, drop in your GitHub app values and provider key, then start PR
              Agent with Compose.
            </p>
            <CodeBlock>{COMPOSE_SNIPPET}</CodeBlock>
            <p className="mt-6 text-xs font-medium text-ink-faint">Minimum keys to set</p>
            <CodeBlock>{ENV_SNIPPET}</CodeBlock>
          </div>
        </li>

        <li className="grid gap-3 py-10 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-8 sm:py-12 md:grid-cols-[5.5rem_minmax(0,1fr)]">
          <StepNumber n="03" />
          <div className="min-w-0 max-w-2xl">
            <h3 className="text-lg font-medium leading-snug text-ink sm:text-xl">
              Open a PR and talk to it
            </h3>
            <p className="mt-2 text-[0.98rem] leading-relaxed text-ink-mute sm:text-base">
              Install the app on a repo, open a pull request, and wait for the automatic pass. Or
              type a command in the conversation when you want more.
            </p>
            <ul className="surface-inset edge-self mt-5 divide-y divide-edge rounded-md">
              {SLASH_COMMANDS.map((item) => (
                <li
                  key={item.cmd}
                  className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4 sm:px-5"
                >
                  <code className="shrink-0 font-mono text-sm text-bolt">{item.cmd}</code>
                  <span className="text-sm leading-relaxed text-ink-mute">{item.tip}</span>
                </li>
              ))}
            </ul>
          </div>
        </li>
      </ol>
    </Section>
  );
}
