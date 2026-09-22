import type { ReactNode } from "react";
import { ButtonLink } from "@/components/button";
import { CodeBlock } from "@/components/code-block";
import { ArrowUpRight } from "@/components/icons";
import { Section, SectionHeading } from "@/components/section";
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

type StepProps = {
  readonly n: string;
  readonly title: string;
  readonly body: string;
  readonly children: ReactNode;
};

function Step({ n, title, body, children }: StepProps) {
  return (
    <li className="grid gap-6 rounded-lg bg-surface p-6 shadow-card sm:p-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-12">
      <div>
        <p className="tabular inline-flex h-7 items-center rounded-full bg-accent-soft px-2.5 text-xs font-semibold text-accent-text">
          Step {n}
        </p>
        <h3 className="mt-4 text-xl font-medium tracking-[-0.015em] text-text">{title}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">{body}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

export function Quickstart() {
  return (
    <Section id="usage" labelledBy="usage-heading">
      <SectionHeading
        id="usage-heading"
        eyebrow={QUICKSTART_HEADING}
        title="Three steps from a fresh machine to a review"
        description={QUICKSTART_INTRO}
        action={
          <ButtonLink
            href={DOCS_URL}
            external
            variant="secondary"
            trailingIcon={<ArrowUpRight className="size-4 text-text-tertiary" />}
          >
            Open the README
          </ButtonLink>
        }
      />

      <ol className="mt-10 space-y-4 sm:mt-12">
        <Step n={STEP_ONE.n} title={STEP_ONE.title} body={STEP_ONE.body}>
          <dl className="divide-y divide-line rounded-md bg-surface-raised px-5 shadow-ring">
            {APP_FIELDS.map((field) => (
              <div
                key={field.label}
                className="grid gap-1 py-4 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4"
              >
                <dt className="text-xs font-medium text-text-tertiary sm:pt-0.5">{field.label}</dt>
                <dd
                  className={
                    field.mono
                      ? "font-mono text-sm break-words text-accent-text"
                      : "text-sm leading-relaxed text-text-secondary"
                  }
                >
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-text-tertiary">
            Full steps are in{" "}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-secondary underline decoration-line transition-colors duration-150 hover:text-text"
            >
              README Installation
            </a>
            .
          </p>
        </Step>

        <Step n={STEP_TWO.n} title={STEP_TWO.title} body={STEP_TWO.body}>
          <div className="space-y-4">
            <CodeBlock label="Terminal" code={COMPOSE_SNIPPET} language="bash" />
            <div>
              <p className="mb-2 text-xs font-medium text-text-tertiary">Minimum keys to set</p>
              <CodeBlock label=".env" code={ENV_SNIPPET} language="dotenv" />
            </div>
          </div>
        </Step>

        <Step n={STEP_THREE.n} title={STEP_THREE.title} body={STEP_THREE.body}>
          <ul className="divide-y divide-line rounded-md bg-surface-raised px-5 shadow-ring">
            {SLASH_COMMANDS.map((item) => (
              <li
                key={item.cmd}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4"
              >
                <code className="shrink-0 font-mono text-sm text-accent-text">{item.cmd}</code>
                <span className="text-sm leading-relaxed text-text-secondary">{item.tip}</span>
              </li>
            ))}
          </ul>
        </Step>
      </ol>
    </Section>
  );
}
