import { CodeBlock } from "@/components/ui/code-block";
import { Section, SectionHeading } from "@/components/ui/section";
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

function Step({
  index,
  title,
  body,
  children,
}: {
  readonly index: number;
  readonly title: string;
  readonly body: string;
  readonly children: React.ReactNode;
}) {
  return (
    <li className="grid gap-6 py-12 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
      <div>
        <p className="tabular font-mono text-[13px] text-blue">Step {index + 1}</p>
        <h3 className="mt-2 text-2xl font-semibold leading-tight text-fg">{title}</h3>
        <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-fg-muted">{body}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

export function Install() {
  return (
    <Section id="install" labelledBy="install-heading" tone="surface">
      <SectionHeading id="install-heading" lede={QUICKSTART_INTRO}>
        {QUICKSTART_HEADING}
      </SectionHeading>

      <ol className="mt-14 divide-y divide-line">
        <Step index={0} title={STEP_ONE.title} body={STEP_ONE.body}>
          <dl className="card divide-y divide-line rounded-[12px]">
            {APP_FIELDS.map((field) => (
              <div
                key={field.label}
                className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4"
              >
                <dt className="text-[13px] font-medium text-fg-subtle">{field.label}</dt>
                <dd
                  className={
                    field.mono
                      ? "min-w-0 font-mono text-[13px] text-accent-ink [overflow-wrap:anywhere]"
                      : "min-w-0 text-sm leading-relaxed text-fg"
                  }
                >
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-fg-subtle">
            Every setting, with screenshots, is in the{" "}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-fg underline decoration-line-strong hover:decoration-fg"
            >
              README installation guide
            </a>
            .
          </p>
        </Step>

        <Step index={1} title={STEP_TWO.title} body={STEP_TWO.body}>
          <CodeBlock code={COMPOSE_SNIPPET} label="Compose commands" />
          <p className="mb-2 mt-6 text-[13px] font-medium text-fg-subtle">The keys to fill in</p>
          <CodeBlock code={ENV_SNIPPET} label="environment keys" />
        </Step>

        <Step index={2} title={STEP_THREE.title} body={STEP_THREE.body}>
          <ul className="card divide-y divide-line rounded-[12px]">
            {SLASH_COMMANDS.map((item) => (
              <li
                key={item.cmd}
                className="grid gap-1 px-4 py-3 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-4"
              >
                <code className="text-[13px] font-medium text-accent-ink">{item.cmd}</code>
                <span className="text-sm leading-relaxed text-fg-muted">{item.tip}</span>
              </li>
            ))}
          </ul>
        </Step>
      </ol>
    </Section>
  );
}
