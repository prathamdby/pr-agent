import { DOCS_URL } from "@/lib/site";

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="relative overflow-hidden">
      {/* Background gradient flourish */}
      <div
        className="absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(12,140,94,0.08), transparent)",
        }}
        aria-hidden="true"
      />

      <div className="grid-layout pt-20 pb-16 md:pt-24 md:pb-20">
        <div className="col-span-4 md:col-span-12 lg:col-span-24 flex flex-col items-center text-center">
          {/* Pill badge */}
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border-secondary bg-background-secondary px-4 py-1 text-sm text-foreground-muted">
            <span className="size-1.5 rounded-full bg-brand-base" />
            Reviews &middot; Descriptions &middot; Q&amp;A
          </div>

          {/* Hero title */}
          <h1
            id="hero-heading"
            className="hero-title max-w-3xl text-balance"
          >
            Self-hosted AI pull request review platform
          </h1>

          {/* Description */}
          <p className="mt-6 text-lg text-foreground-secondary max-w-2xl leading-relaxed">
            PR Agent is a full platform you deploy yourself: webhook intake, durable job
            queues, AI workers, and publish back to GitHub. An open-source alternative to
            hosted reviewers like CodeRabbit, Greptile, and Cursor Bugbot.
          </p>

          <p className="mt-3 text-foreground-tertiary">
            Reviews, descriptions, and Q&amp;A on pull requests. Your infrastructure, your
            credentials, your model provider.
          </p>

          {/* CTAs */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-brand-base px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-vivid transition-all duration-200 shadow-button-sm"
            >
              Get started
              <svg
                className="h-4 w-4"
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
            </a>
            <a
              href="#examples"
              className="inline-flex items-center rounded-lg border border-border-secondary px-5 py-2.5 text-sm font-medium text-foreground-primary hover:bg-background-secondary transition-colors duration-200"
            >
              See examples
            </a>
          </div>

          {/* Scroll hint */}
          <p className="mt-6 text-xs text-foreground-muted">
            Or scroll to{" "}
            <a href="#usage" className="underline hover:text-foreground-secondary transition-colors duration-200">
              usage
            </a>{" "}
            for Docker Compose quickstart.
          </p>
        </div>
      </div>
    </section>
  );
}
