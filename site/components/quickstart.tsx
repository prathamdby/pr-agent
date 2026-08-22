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
          {QUICKSTART_HEADING}
        </h2>
        <p className="mt-4 text-base leading-relaxed text-ink-mute sm:text-[1.05rem]">
          {QUICKSTART_INTRO}
        </p>
      </header>

      <ol className="mt-12 border-t border-edge">
        <li className="grid gap-3 border-b border-edge py-10 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-8 sm:py-12 md:grid-cols-[5.5rem_minmax(0,1fr)]">
          <StepNumber n={STEP_ONE.n} />
          <div className="min-w-0 max-w-2xl">
            <h3 className="text-lg font-medium leading-snug text-ink sm:text-xl">
              {STEP_ONE.title}
            </h3>
            <p className="mt-2 text-[0.98rem] leading-relaxed text-ink-mute sm:text-base">
              {STEP_ONE.body}
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
          <StepNumber n={STEP_TWO.n} />
          <div className="min-w-0 max-w-2xl">
            <h3 className="text-lg font-medium leading-snug text-ink sm:text-xl">
              {STEP_TWO.title}
            </h3>
            <p className="mt-2 text-[0.98rem] leading-relaxed text-ink-mute sm:text-base">
              {STEP_TWO.body}
            </p>
            <CodeBlock>{COMPOSE_SNIPPET}</CodeBlock>
            <p className="mt-6 text-xs font-medium text-ink-faint">Minimum keys to set</p>
            <CodeBlock>{ENV_SNIPPET}</CodeBlock>
          </div>
        </li>

        <li className="grid gap-3 py-10 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-8 sm:py-12 md:grid-cols-[5.5rem_minmax(0,1fr)]">
          <StepNumber n={STEP_THREE.n} />
          <div className="min-w-0 max-w-2xl">
            <h3 className="text-lg font-medium leading-snug text-ink sm:text-xl">
              {STEP_THREE.title}
            </h3>
            <p className="mt-2 text-[0.98rem] leading-relaxed text-ink-mute sm:text-base">
              {STEP_THREE.body}
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
