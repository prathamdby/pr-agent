import { CopyButton } from "@/components/copy-button";
import { REPO_URL } from "@/lib/site";

const CLONE_COMMAND = `git clone ${REPO_URL}`;

export function CtaBanner() {
  return (
    <section
      aria-labelledby="cta-heading"
      className="sky-fold-lead pt-18 pb-10 text-center sm:pt-28 sm:pb-16"
    >
      <div className="container-x">
        <h2
          id="cta-heading"
          className="text-[clamp(2.375rem,4.8vw,4rem)] font-medium leading-[1.04] tracking-[-0.035em] text-text"
        >
          Run the{" "}
          <span className="word-pill wash overflow-visible shadow-soft max-sm:mx-auto max-sm:my-2.5 max-sm:flex max-sm:w-fit">
            <span className="word-pill-avatar bg-surface shadow-soft">
              <img src="/logo.png" alt="" width={40} height={40} className="outline-none" />
            </span>
            <span className="self-baseline">reviewer</span>
          </span>{" "}
          yourself
        </h2>
        <p className="mx-auto mt-5 max-w-[46ch] text-base leading-relaxed text-text-secondary sm:text-lg">
          Clone the repository, fill one env file, and start the stack with Compose. The first
          review lands on your next pull request.
        </p>
        <div className="mx-auto mt-7 flex max-w-full flex-col gap-1.5 rounded-md bg-surface p-1.5 shadow-card sm:mt-8 sm:w-fit sm:flex-row sm:items-center sm:gap-2">
          <code
            className="min-w-0 overflow-hidden px-2.5 pt-2.5 pb-1.5 text-left text-sm whitespace-nowrap text-text-secondary mask-r-from-80% sm:truncate sm:py-0 sm:pr-2 sm:pl-3 sm:mask-none"
            title={CLONE_COMMAND}
          >
            {CLONE_COMMAND}
          </code>
          <div className="grid">
            <CopyButton text={CLONE_COMMAND} label="Copy command" variant="primary" />
          </div>
        </div>
      </div>
    </section>
  );
}
