import { LICENSE_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

export function Footer() {
  return (
    <footer className="bg-background-secondary">
      <div className="grid-layout">
        <div className="grid-layout-inner py-12">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex items-center gap-2.5">
              <img
                src="/logo.png"
                alt={`${PRODUCT_NAME} logo`}
                width={28}
                height={28}
                className="rounded-[10px]"
              />
              <span className="font-semibold tracking-tight text-foreground-primary">
                {PRODUCT_NAME}
              </span>
            </div>
            <p className="max-w-md text-sm text-foreground-tertiary">
              {PRODUCT_NAME} is an open-source, self-hosted AI pull request review platform for
              GitHub.
            </p>
            <div className="flex items-center gap-6 text-sm">
              <a
                href={LICENSE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground-secondary hover:text-foreground-primary underline underline-offset-2 transition-colors duration-200"
                style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
              >
                license
              </a>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground-secondary hover:text-foreground-primary underline underline-offset-2 transition-colors duration-200"
                style={{ transitionTimingFunction: "var(--ease-out-soft)" }}
              >
                github
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
