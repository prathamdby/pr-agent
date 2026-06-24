import { DOCS_URL } from "@/lib/site";

function ChevronRightIcon({ className }: { readonly className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function SparkleIcon({ className }: { readonly className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.4l-1.9-5.8L4 10.7l6.1-1.9z" />
    </svg>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="relative overflow-hidden" data-line>
      {/* gradient flourish */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          background: "radial-gradient(60% 50% at 50% 0%, var(--brand-base) 0%, transparent 70%)",
        }}
      />
      <div className="grid-layout relative">
        <div className="grid-layout-inner py-20 md:py-28">
          <div className="animate-fade-in-up">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border-secondary bg-background-secondary px-3.5 py-1.5 text-sm text-foreground-secondary">
              <SparkleIcon className="h-3.5 w-3.5 text-brand-base" />
              <span>Reviews · Descriptions · Q&A</span>
              <ChevronRightIcon className="h-3 w-3 text-foreground-muted" />
            </div>

            <h1 id="hero-heading" className="hero-title mb-6 max-w-2xl text-foreground-primary">
              Self-hosted AI pull request review platform
            </h1>

            <p className="max-w-xl text-lg leading-relaxed text-foreground-secondary mb-4">
              PR Agent is a full platform you deploy yourself: webhook intake, durable job queues,
              AI workers, and publish back to GitHub. An open-source alternative to hosted reviewers
              like CodeRabbit, Greptile, and Cursor Bugbot.
            </p>

            <p className="max-w-xl text-base text-foreground-tertiary mb-8">
              Reviews, descriptions, and Q&A on pull requests. Your infrastructure, your
              credentials, your model provider.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-brand-base px-5 py-2.5 text-sm font-medium text-background-primary hover:opacity-90 transition-opacity duration-200"
                style={{
                  boxShadow: "var(--shadow-button-sm)",
                  transitionTimingFunction: "var(--ease-out-soft)",
                }}
              >
                Get started
                <ChevronRightIcon className="h-4 w-4" />
              </a>
              <a
                href="#examples"
                className="inline-flex items-center rounded-full border border-border-secondary bg-background-secondary px-5 py-2.5 text-sm font-medium text-foreground-primary hover:bg-background-tertiary transition-colors duration-200"
                style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
              >
                See examples
              </a>
            </div>

            <p className="mt-5 text-sm text-foreground-muted">
              Or scroll to{" "}
              <a
                href="#usage"
                className="text-brand-base hover:opacity-80 underline underline-offset-2"
              >
                usage
              </a>{" "}
              for Docker Compose quickstart.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
