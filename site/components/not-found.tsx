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
      className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center px-4 py-24 sm:px-6"
    >
      <p
        aria-hidden="true"
        className="font-display text-[clamp(4.5rem,14vw,9rem)] leading-[0.85] tracking-[-0.03em] text-ink/[0.18]"
      >
        404
      </p>
      <h1 className="mt-6 font-display text-[clamp(2.1rem,4.2vw,3.25rem)] leading-[1.05] tracking-[-0.02em] text-ink">
        This page does not exist
      </h1>
      <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-ink-mute sm:text-[1.05rem]">
        The PR Agent site is one landing page plus a few machine-readable files. Everything it
        publishes is listed here.
      </p>

      <ul className="surface-inset edge-self mt-10 divide-y divide-edge rounded-md">
        {AGENT_RESOURCES.map((resource) => (
          <li
            key={resource.path}
            className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4 sm:px-5"
          >
            <a
              href={resource.path}
              className="shrink-0 font-mono text-sm text-bolt transition-colors hover:text-ink"
            >
              {resource.path}
            </a>
            <span className="text-sm leading-relaxed text-ink-mute">{resource.description}</span>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-sm leading-relaxed text-ink-mute">
        Deployment docs and source live in the repository:{" "}
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink-soft underline decoration-edge-strong transition-colors hover:text-ink"
        >
          github.com/prathamdby/pr-agent
        </a>
        .
      </p>
    </main>
  );
}
