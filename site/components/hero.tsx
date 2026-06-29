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
    <section aria-labelledby="hero-heading" className="px-4 pt-12 pb-8">
      <div className="mx-auto max-w-xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-sm text-neutral-600">
          <span>Your code stays on your servers</span>
          <ChevronRightIcon className="h-3 w-3" />
        </div>

        <h1 id="hero-heading" className="text-2xl leading-tight mb-4">
          AI reviews your pull requests on your own servers
        </h1>

        <p className="text-neutral-600 mb-3">
          Your reviewers are stuck checking the same basics on every PR. PR Agent does that first
          pass in GitHub, then leaves the hard calls to humans.
        </p>

        <p className="text-neutral-600 mb-6">
          Same review every PR gets, minus the per-seat bill. Your servers, your API keys, your code
          never leaves.
        </p>

        <div>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-white hover:bg-blue-700 transition-colors"
          >
            Deploy right now
            <ChevronRightIcon className="h-4 w-4" />
          </a>
        </div>

        <p className="mt-3 text-xs text-neutral-500">
          Open source under MIT. You pay only for your own hosting and AI usage.
        </p>
      </div>
    </section>
  );
}
