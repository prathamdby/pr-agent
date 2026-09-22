import { ButtonLink } from "@/components/button";
import { ArrowUpRight, Plus } from "@/components/icons";
import { Eyebrow, Section } from "@/components/section";
import { FAQ_ITEMS } from "@/lib/content";
import { REPO_URL } from "@/lib/site";

const ISSUES_URL = `${REPO_URL}/issues`;

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-heading">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow>FAQ</Eyebrow>
          <h2
            id="faq-heading"
            className="mt-4 text-[clamp(1.875rem,3.4vw,2.625rem)] font-medium leading-[1.12] tracking-[-0.025em] text-text"
          >
            Questions teams ask before they deploy
          </h2>
          <p className="mt-4 max-w-[40ch] text-base leading-relaxed text-text-secondary sm:text-[1.0625rem]">
            Find your starting point here. If your question is missing, open an issue and it gets
            answered in the repository.
          </p>
          <div className="mt-8">
            <ButtonLink
              href={ISSUES_URL}
              external
              trailingIcon={<ArrowUpRight className="size-4" />}
            >
              Open an issue
            </ButtonLink>
          </div>
        </div>

        <div className="rounded-lg bg-surface px-5 shadow-card sm:px-6">
          {FAQ_ITEMS.map((item, index) => (
            <details
              key={item.question}
              name="faq"
              open={index === 0}
              className="disclosure group border-b border-line last:border-b-0"
            >
              <summary className="group/summary flex items-center justify-between gap-6 py-5 text-[15px] font-medium text-text">
                <h3 className="font-medium">{item.question}</h3>
                <span
                  aria-hidden="true"
                  className="grid size-8 shrink-0 place-items-center rounded-full text-text-tertiary transition-colors duration-150 group-open:bg-surface-raised group-open:text-text group-hover/summary:text-text"
                >
                  <Plus className="disclosure-icon size-4" />
                </span>
              </summary>
              <p className="max-w-[52ch] pb-5 text-[15px] leading-relaxed text-text-secondary">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}
