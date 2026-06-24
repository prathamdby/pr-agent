import { Link } from "@tanstack/react-router";
import { DOCS_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Header() {
  return (
    <header className="container-geist flex items-center justify-between py-4">
      <Link
        to="/"
        className="flex items-center gap-2 text-gray-1000 no-underline hover:no-underline"
        aria-label={`${PRODUCT_NAME} home`}
      >
        <img
          src="/logo.png"
          alt={`${PRODUCT_NAME} logo`}
          width={28}
          height={28}
          className="rounded-sm"
        />
        <span className="heading-14">{PRODUCT_NAME}</span>
      </Link>

      <nav className="flex items-center gap-1" aria-label="Primary navigation">
        <a href="#examples" className="btn-tertiary btn-small no-underline">
          Examples
        </a>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-tertiary btn-small no-underline"
        >
          Docs
        </a>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-tertiary btn-small no-underline"
        >
          GitHub
        </a>
        <div className="w-2" />
        <a href="#usage" className="btn-primary btn-small no-underline">
          Get Started
        </a>
      </nav>
    </header>
  );
}
