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

export function Hero() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="px-4 pb-12 pt-16 sm:px-6 sm:pb-16 sm:pt-24 lg:px-8"
    >
      <div className="mx-auto max-w-[1200px]">
        <div className="inline-flex items-center gap-2 rounded-full border border-gray-alpha-200 bg-background-200 px-3 py-1 text-label-12 text-secondary">
          <span>Reviews · Descriptions · Q&A</span>
          <ChevronRightIcon className="h-3 w-3" />
        </div>

        <h1
          id="hero-heading"
          className="mt-6 max-w-3xl text-heading-32 text-primary sm:text-heading-40 lg:text-heading-48"
        >
          Self-Hosted AI Pull Request Review Platform
        </h1>

        <p className="mt-6 max-w-2xl text-copy-18 text-secondary">
          PR Agent is a full platform you deploy yourself: webhook intake, durable job queues, AI
          workers, and publish back to GitHub. An open-source alternative to hosted reviewers like
          CodeRabbit, Greptile, and Cursor Bugbot.
        </p>

        <p className="mt-4 max-w-2xl text-copy-16 text-gray-700">
          Reviews, descriptions, and Q&A on pull requests. Your infrastructure, your credentials,
          your model provider.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-12 items-center gap-2 rounded-sm bg-primary px-5 text-button-16 text-background-100 transition-colors hover:bg-gray-900"
          >
            Get Started
            <ChevronRightIcon className="h-4 w-4" />
          </a>
          <a
            href="#examples"
            className="inline-flex h-12 items-center rounded-sm border border-gray-alpha-400 bg-background-100 px-5 text-button-16 text-primary transition-colors hover:bg-gray-100"
          >
            See Examples
          </a>
        </div>
      </div>
    </section>
  );
}
