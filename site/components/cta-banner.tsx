import { CopyButton } from "@/components/copy-button";
import { REPO_URL } from "@/lib/site";

const CLONE_COMMAND = `git clone ${REPO_URL}`;

/** Hand-drawn underline: one quick stroke, stretched under the word. */
function Scribble({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`pointer-events-none ${className ?? ""}`}
      viewBox="0 0 240 24"
      preserveAspectRatio="none"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d="M4 14C44 4 90 20 130 10S206 4 236 12"
        strokeWidth="4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function CtaBanner() {
  return (
    <section aria-labelledby="cta-heading" className="pt-4">
      <div className="wash wash-grid wash-grid-fade wash-clouds py-12 text-center sm:py-16">
        <div className="container-x">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_55%,var(--color-surface)_100%)]"
          />
          <div className="relative">
            <h2
              id="cta-heading"
              className="text-[clamp(2.25rem,5vw,3.75rem)] font-medium leading-[1.04] tracking-[-0.035em] text-text"
            >
              Run the{" "}
              <span className="accent-word relative inline-block italic">
                reviewer
                <Scribble className="absolute -bottom-1.5 left-0 h-3 w-full text-accent-solid sm:-bottom-2 sm:h-4" />
              </span>{" "}
              yourself
            </h2>
            <p className="mx-auto mt-5 max-w-[46ch] text-base leading-relaxed text-text-secondary sm:text-lg">
              Clone the repository, fill one env file, and start the stack with Compose. The first
              review lands on your next pull request.
            </p>
            <div className="mx-auto mt-8 flex w-fit max-w-full items-center gap-2 rounded-md bg-surface p-1.5 shadow-card">
              <code
                className="min-w-0 truncate pr-2 pl-3 text-left text-sm text-text-secondary"
                title={CLONE_COMMAND}
              >
                {CLONE_COMMAND}
              </code>
              <CopyButton text={CLONE_COMMAND} label="Copy command" variant="primary" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
