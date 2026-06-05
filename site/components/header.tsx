import Image from "next/image";
import Link from "next/link";
import { DOCS_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Header() {
  return (
    <header className="py-4 px-4">
      <div className="mx-auto max-w-xl flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 text-neutral-800"
          aria-label={`${PRODUCT_NAME} home`}
        >
          <Image
            src="/logo.png"
            alt={`${PRODUCT_NAME} logo`}
            width={32}
            height={32}
            className="rounded"
            priority
          />
          <span className="font-medium">{PRODUCT_NAME}</span>
        </Link>

        <nav
          className="flex items-center gap-3 text-sm"
          aria-label="Primary navigation"
        >
          <Link
            href="#examples"
            className="hidden sm:inline text-neutral-500 hover:text-neutral-800 underline"
          >
            examples
          </Link>
          <Link
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-500 hover:text-neutral-800 underline"
          >
            docs
          </Link>
          <Link
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-500 hover:text-neutral-800 underline"
          >
            github
          </Link>
          <Link
            href="#usage"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            get started
          </Link>
        </nav>
      </div>
    </header>
  );
}
