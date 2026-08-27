import { Section } from "@/components/section";
import {
  APP_FIELDS,
  COMPOSE_SNIPPET,
  ENV_SNIPPET,
  QUICKSTART_HEADING,
  QUICKSTART_INTRO,
  QUICKSTART_STEPS,
  SLASH_COMMANDS,
} from "@/lib/content";
import { DOCS_URL } from "@/lib/site";

const [STEP_ONE, STEP_TWO, STEP_THREE] = QUICKSTART_STEPS;

function CodeBlock({ children }: { readonly children: string }) {
  return (
    <pre className="surface-inset edge-self mt-3 overflow-x-auto p-3 text-[0.8rem] leading-relaxed text-ink-soft sm:p-4">
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
          className="font-display text-[clamp(1.5rem,2.8vw,2.15rem)] leading-tight text-ink"
        >
          {QUICKSTART_HEADING}
        </h2>
        <p className="mt-2 text-sm leading-snug text-ink-mute sm:text-[0.95rem]">
          {QUICKSTART_INTRO}
        </p>
      </header>

      <ol className="mt-6 space-y-8">
        <li className="min-w-0 max-w-3xl">
          <h3 className="text-base font-medium leading-snug text-ink sm:text-lg">
            {STEP_ONE.title}
          </h3>
          <p className="mt-1.5 text-sm leading-snug text-ink-mute">{STEP_ONE.body}</p>
          <dl className="mt-4 space-y-3">
            {APP_FIELDS.map((field) => (
              <div key={field.label}>
                <dt className="text-xs font-medium text-ink-faint">{field.label}</dt>
                <dd
                  className={
                    field.mono
                      ? "mt-0.5 font-mono text-sm text-bolt"
                      : "mt-0.5 text-sm leading-snug text-ink-soft"
                  }
                >
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-sm leading-snug text-ink-faint">
            Click-by-click path:{" "}
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
        </li>

        <li className="min-w-0 max-w-3xl">
          <h3 className="text-base font-medium leading-snug text-ink sm:text-lg">
            {STEP_TWO.title}
          </h3>
          <p className="mt-1.5 text-sm leading-snug text-ink-mute">{STEP_TWO.body}</p>
          <CodeBlock>{COMPOSE_SNIPPET}</CodeBlock>
          <p className="mt-4 text-xs font-medium text-ink-faint">Minimum keys to set</p>
          <CodeBlock>{ENV_SNIPPET}</CodeBlock>
        </li>

        <li className="min-w-0 max-w-3xl">
          <h3 className="text-base font-medium leading-snug text-ink sm:text-lg">
            {STEP_THREE.title}
          </h3>
          <p className="mt-1.5 text-sm leading-snug text-ink-mute">{STEP_THREE.body}</p>
          <ul className="surface-inset edge-self mt-3 divide-y divide-edge">
            {SLASH_COMMANDS.map((item) => (
              <li
                key={item.cmd}
                className="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:gap-4 sm:px-4"
              >
                <code className="shrink-0 font-mono text-sm text-bolt">{item.cmd}</code>
                <span className="text-sm leading-snug text-ink-mute">{item.tip}</span>
              </li>
            ))}
          </ul>
        </li>
      </ol>
    </Section>
  );
}
