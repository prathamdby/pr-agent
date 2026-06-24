import { LICENSE_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Footer() {
  return (
    <footer className="border-t border-gray-alpha-200 bg-background-100 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <p className="text-copy-14 text-secondary">
          {PRODUCT_NAME} is an open-source, self-hosted AI pull request review platform for GitHub.
        </p>
        <div className="flex items-center gap-4 text-copy-14 text-secondary">
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-primary"
          >
            License
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-primary"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
