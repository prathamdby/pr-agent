import { AGENT_RESOURCES, DOC_LINKS } from "@/lib/agentResources";
import { llmsNudgeTitle } from "@/lib/llmsKnowledge";
import { LICENSE_URL, REPO_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

const PRODUCT_LINKS = [
  { href: "/#features", label: "How it works" },
  { href: "/#examples", label: "Examples" },
  { href: "/#capabilities", label: "Commands" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
  { href: "/#usage", label: "Installation" },
] as const;

/** Registry titles carry the product name for search. In a column headed by it, drop it. */
function shortTitle(title: string): string {
  const stripped = title.replace(new RegExp(`^${PRODUCT_NAME} `), "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

const AGENT_FILES = AGENT_RESOURCES.filter(
  (resource) => resource.inSitemap && resource.path !== "/",
);

const linkClassName =
  "inline-flex min-h-8 items-center text-sm text-text-secondary transition-colors duration-150 hover:text-text";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer>
      <div className="container-x pt-16 pb-6 sm:pt-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
          <div>
            <a href="/" className="inline-flex items-center gap-2.5 rounded-sm text-text">
              <img
                src="/logo.png"
                alt=""
                width={28}
                height={28}
                className="size-7 rounded-sm outline-none"
              />
              <span className="text-[15px] font-semibold tracking-[-0.01em]">{PRODUCT_NAME}</span>
            </a>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-text-secondary">
              AI pull request reviews on servers you run. MIT licensed, no per-seat fee, your GitHub
              credentials and model keys stay with you.
            </p>
          </div>

          <div className="grid gap-10 sm:grid-cols-3">
            <div>
              <p className="text-sm font-medium text-text">Product</p>
              <ul className="mt-3 flex flex-col gap-1">
                {PRODUCT_LINKS.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} className={linkClassName}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-sm font-medium text-text">Documentation</p>
              <ul className="mt-3 flex flex-col gap-1">
                {DOC_LINKS.map((doc) => (
                  <li key={doc.url}>
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClassName}
                    >
                      {shortTitle(doc.title)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-sm font-medium text-text">For agents</p>
              <ul className="mt-3 flex flex-col gap-1">
                {AGENT_FILES.map((resource) => (
                  <li key={resource.path}>
                    <a
                      href={resource.path}
                      title={resource.description}
                      className={`${linkClassName} font-mono text-[13px]`}
                    >
                      {resource.path}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-line pt-6 text-[13px] text-text-tertiary sm:flex-row sm:items-center sm:justify-between">
          <p className="tabular">
            © {year} {PRODUCT_NAME}. MIT licensed.
          </p>
          <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <li>
              <a
                href={LICENSE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors duration-150 hover:text-text"
              >
                License
              </a>
            </li>
            <li>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors duration-150 hover:text-text"
              >
                GitHub
              </a>
            </li>
            <li>
              <a
                href="/llms.txt"
                title={llmsNudgeTitle()}
                className="transition-colors duration-150 hover:text-text"
              >
                llms.txt
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div aria-hidden="true" className="wordmark-clip container-x">
        <span className="wordmark-sky">{PRODUCT_NAME}</span>
      </div>
    </footer>
  );
}
