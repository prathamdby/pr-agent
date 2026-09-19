import { ButtonLink } from "@/components/ui/button";
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
    <main
      id="main-content"
      className="mx-auto flex min-h-dvh w-full max-w-[1200px] flex-col justify-center px-5 py-24 sm:px-8"
    >
      <p className="font-mono text-sm font-medium text-accent-ink">404</p>
      <h1 className="mt-3 text-4xl font-semibold leading-[1.05] text-fg md:text-5xl">
        This page does not exist
      </h1>
      <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-fg-muted md:text-lg">
        The PR Agent site is one landing page plus a few machine-readable files. Everything it
        publishes is listed here.
      </p>
      <div className="mt-8">
        <ButtonLink href="/">Go to the landing page</ButtonLink>
      </div>

      <ul className="mt-12 divide-y divide-line rounded-panel bg-surface shadow-border">
        {AGENT_RESOURCES.map((resource) => (
          <li
            key={resource.path}
            className="grid gap-1 px-5 py-3.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4"
          >
            <a
              href={resource.path}
              className="link-muted font-mono text-[13px] font-medium text-accent-ink transition-colors duration-150"
            >
              {resource.path}
            </a>
            <span className="text-sm leading-relaxed text-fg-muted">{resource.description}</span>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-sm leading-relaxed text-fg-muted">
        Deployment docs and source live in the repository:{" "}
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-fg underline decoration-line-strong hover:decoration-fg"
        >
          github.com/prathamdby/pr-agent
        </a>
        .
      </p>
    </main>
  );
}
