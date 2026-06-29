import { Link } from "@tanstack/react-router";
import { DOCS_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Header() {
  return (
    <header className="py-4 px-4">
      <div className="mx-auto max-w-xl flex items-center justify-between">
        <Link
          to="/"
          className="flex items-center gap-2 text-neutral-800"
          aria-label={`${PRODUCT_NAME} home`}
        >
          <img
            src="/logo.png"
            alt={`${PRODUCT_NAME} logo`}
            width={32}
            height={32}
            className="rounded"
          />
          <span className="font-medium">{PRODUCT_NAME}</span>
        </Link>

        <nav className="flex items-center gap-3 text-sm" aria-label="Primary navigation">
          <a
            href="#examples"
            className="hidden sm:inline text-neutral-500 hover:text-neutral-800 underline"
          >
            examples
          </a>
          <a
            href="#pricing"
            className="hidden sm:inline text-neutral-500 hover:text-neutral-800 underline"
          >
            pricing
          </a>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-500 hover:text-neutral-800 underline"
          >
            docs
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-500 hover:text-neutral-800 underline"
          >
            github
          </a>
          <a
            href="#usage"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            deploy
          </a>
        </nav>
      </div>
    </header>
  );
}
