import { ButtonLink } from "@/components/ui/button";
import { llmsNudgeTitle } from "@/lib/llmsKnowledge";
import { PRODUCT_NAME } from "@/lib/seo";
import { LICENSE_URL, REPO_URL } from "@/lib/site";

const LINKS = [
  { href: REPO_URL, label: "GitHub", external: true },
  { href: LICENSE_URL, label: "MIT license", external: true },
  { href: "#install", label: "Install", external: false },
] as const;

export function Footer() {
  return (
    <footer className="px-5 pb-10 pt-20 sm:px-8 md:pt-28">
      <div className="mx-auto w-full max-w-[1200px]">
        <div className="card rounded-panel px-6 py-12 sm:px-12 sm:py-16">
          <div className="grid items-center gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <p className="font-display text-3xl font-semibold leading-[1.1] tracking-[-0.02em] text-fg md:text-4xl">
                Stop renting your code review. Own it.
              </p>
              <p className="mt-4 max-w-[46ch] text-base leading-relaxed text-fg-muted">
                One Compose file, one GitHub App, one provider key. The first review lands on your
                next pull request.
              </p>
            </div>
            <ButtonLink href="#install" size="lg">
              Deploy
            </ButtonLink>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="" width={24} height={24} className="size-6 rounded-[6px]" />
            <span className="text-sm font-semibold text-fg">{PRODUCT_NAME}</span>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            {LINKS.map((link) =>
              link.external ? (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-muted text-fg-muted transition-colors duration-150"
                >
                  {link.label}
                </a>
              ) : (
                <a
                  key={link.label}
                  href={link.href}
                  className="link-muted text-fg-muted transition-colors duration-150"
                >
                  {link.label}
                </a>
              ),
            )}
            <a
              href="/llms.txt"
              title={llmsNudgeTitle()}
              className="link-muted font-mono text-xs text-fg-subtle transition-colors duration-150"
            >
              llms.txt
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
