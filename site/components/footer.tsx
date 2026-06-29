import { LICENSE_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Footer() {
  return (
    <footer className="px-4 py-8 border-t border-neutral-100">
      <div className="mx-auto max-w-xl">
        <p className="text-sm text-neutral-500 mb-4">Stop renting your code review. Own it.</p>
        <div className="flex items-center justify-between text-sm text-neutral-500">
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-neutral-800"
          >
            license
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-neutral-800"
          >
            github
          </a>
        </div>
      </div>
    </footer>
  );
}
