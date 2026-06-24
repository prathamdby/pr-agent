import { Link } from "@tanstack/react-router";
import { DOCS_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-gray-alpha-200 bg-background-100/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="flex items-center gap-2 text-primary"
          aria-label={`${PRODUCT_NAME} home`}
        >
          <img src="/logo.png" alt="" width={32} height={32} className="rounded-sm" />
          <span className="text-label-16 font-medium">{PRODUCT_NAME}</span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Primary navigation">
          <a
            href="#examples"
            className="hidden h-10 items-center rounded-sm px-3 text-label-14 text-secondary hover:bg-gray-alpha-100 sm:inline-flex"
          >
            Examples
          </a>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center rounded-sm px-3 text-label-14 text-secondary hover:bg-gray-alpha-100"
          >
            Docs
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center rounded-sm px-3 text-label-14 text-secondary hover:bg-gray-alpha-100"
          >
            GitHub
          </a>
          <a
            href="#usage"
            className="inline-flex h-10 items-center rounded-sm bg-primary px-4 text-button-14 text-background-100 transition-colors hover:bg-gray-900"
          >
            Get Started
          </a>
        </nav>
      </div>
    </header>
  );
}
