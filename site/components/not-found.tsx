import { ButtonLink } from "@/components/button";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { ArrowUpRight, ChevronRight } from "@/components/icons";
import { Eyebrow } from "@/components/section";
import { AGENT_RESOURCES } from "@/lib/agentResources";
import { REPO_URL } from "@/lib/site";

/**
 * The HTML half of the 404 response.
 *
 * Agents asking for markdown get the same list from `renderNotFoundMarkdown`. Both exist so a
 * dead link ends in a site map rather than a dead end, whichever representation was negotiated.
 */
export function NotFound() {
  return (
    <>
      <Header />
      <main id="main-content" className="container-x py-16 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
          <div>
            <Eyebrow>404</Eyebrow>
            <h1 className="mt-4 text-[clamp(2rem,4vw,3rem)] font-medium leading-[1.08] tracking-[-0.03em] text-text">
              This page does not exist
            </h1>
            <p className="mt-4 max-w-[46ch] text-base leading-relaxed text-text-secondary sm:text-[1.0625rem]">
              The PR Agent site is one landing page plus a few machine-readable files. Everything it
              publishes is listed here.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/" trailingIcon={<ChevronRight className="size-4" />}>
                Go to the landing page
              </ButtonLink>
              <ButtonLink
                href={REPO_URL}
                external
                variant="secondary"
                trailingIcon={<ArrowUpRight className="size-4 text-text-tertiary" />}
              >
                Open the repository
              </ButtonLink>
            </div>
          </div>

          <ul className="divide-y divide-line rounded-lg bg-surface px-5 shadow-card sm:px-6">
            {AGENT_RESOURCES.map((resource) => (
              <li
                key={resource.path}
                className="flex flex-col gap-1 py-4 sm:flex-row sm:items-baseline sm:gap-5"
              >
                <a
                  href={resource.path}
                  className="hit-area shrink-0 rounded-xs font-mono text-sm text-accent-text transition-colors duration-150 hover:text-text sm:w-40"
                >
                  {resource.path}
                </a>
                <span className="text-sm leading-relaxed text-text-secondary">
                  {resource.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </main>
      <Footer />
    </>
  );
}
