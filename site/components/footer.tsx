import { LICENSE_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Footer() {
  return (
    <footer className="border-t border-border-line bg-background-secondary">
      <div className="grid-layout py-10">
        <div className="col-span-4 md:col-span-12 lg:col-span-24 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-foreground-muted text-center md:text-left">
            {PRODUCT_NAME} — Self-hosted AI pull request review for GitHub. Open source under
            the MIT license.
          </p>
          <div className="flex items-center gap-4 text-sm text-foreground-muted">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground-primary transition-colors duration-200"
            >
              GitHub
            </a>
            <span className="text-border-line" aria-hidden="true">/</span>
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground-primary transition-colors duration-200"
            >
              MIT License
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
