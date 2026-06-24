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

function ArrowUpRightIcon({ className }: { readonly className: string }) {
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
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="section">
      <div className="container-geist text-center">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="badge no-underline hover:no-underline mb-6 inline-flex"
        >
          <span>Self-hosted · Open source · MIT</span>
          <ChevronRightIcon className="h-3 w-3" />
        </a>

        <h1 id="hero-heading" className="heading-56 mx-auto mb-6 max-w-3xl">
          Self-hosted AI pull request review for GitHub
        </h1>

        <p className="copy-18 text-gray-900 mx-auto mb-8 max-w-2xl">
          Deploy webhook intake, durable job queues, AI workers, and GitHub publishing on your own
          infrastructure. An open-source alternative to CodeRabbit, Greptile, and Cursor Bugbot.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary no-underline"
          >
            Get Started
            <ArrowUpRightIcon className="h-4 w-4" />
          </a>
          <a href="#examples" className="btn-secondary no-underline">
            See Examples
          </a>
        </div>

        <p className="label-13 text-gray-700 mt-6">
          Reviews · Descriptions · Security Reviews · Q&amp;A
        </p>
      </div>
    </section>
  );
}
