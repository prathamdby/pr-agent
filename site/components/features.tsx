import { ButtonLink } from "@/components/button";
import { ArrowUpRight, Comment, Gauge, PullRequest, Scan, Server } from "@/components/icons";
import { Eyebrow, Section } from "@/components/section";
import { FEATURES } from "@/lib/content";
import { DOCS_URL } from "@/lib/site";

const STEP_ICONS = [Server, PullRequest, Scan, Comment, Gauge] as const;

export function Features() {
  return (
    <Section id="features" labelledBy="features-heading">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow>How it works</Eyebrow>
          <h2
            id="features-heading"
            className="mt-4 text-[clamp(1.875rem,3.4vw,2.625rem)] font-medium leading-[1.12] tracking-[-0.025em] text-text"
          >
            How a pull request gets its first pass
          </h2>
          <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-secondary sm:text-[1.0625rem]">
            One deploy. After that, every pull request follows the same path inside GitHub. No extra
            dashboard, no per-seat bill from PR Agent.
          </p>
          <div className="mt-8">
            <ButtonLink
              href={DOCS_URL}
              external
              variant="secondary"
              trailingIcon={<ArrowUpRight className="size-4 text-text-tertiary" />}
            >
              Read the install guide
            </ButtonLink>
          </div>
        </div>

        <ol>
          {FEATURES.map((feature, index) => {
            const Icon = STEP_ICONS[index % STEP_ICONS.length];
            const last = index === FEATURES.length - 1;
            return (
              <li
                key={feature.title}
                className="relative grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-5 pb-10 last:pb-0 sm:gap-x-6"
              >
                {last ? null : (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-12 bottom-0 left-[1.375rem] w-px -translate-x-1/2 bg-line"
                  />
                )}
                <span className="grid size-11 place-items-center rounded-sm bg-surface text-accent-text shadow-soft">
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0 pt-1.5">
                  <p className="tabular text-xs font-medium text-text-tertiary">Step {index + 1}</p>
                  <h3 className="mt-1 text-lg leading-snug font-medium text-text sm:text-xl">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-text-secondary">
                    {feature.detail}
                  </p>
                  <p className="mt-4 inline-flex max-w-full items-center rounded-xs bg-surface-raised px-2 py-1 font-mono text-xs text-text-secondary shadow-ring">
                    {feature.cue}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}
