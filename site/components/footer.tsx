import { LICENSE_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Footer() {
  return (
    <footer className="section section-border">
      <div className="container-geist">
        <div className="mx-auto max-w-2xl flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="copy-14 text-gray-700">
            {PRODUCT_NAME} — Open-source, self-hosted AI pull-request review for GitHub.
          </p>
          <div className="flex items-center gap-4">
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="label-13 text-gray-700 no-underline hover:text-gray-1000"
            >
              MIT License
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="label-13 text-gray-700 no-underline hover:text-gray-1000"
            >
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
