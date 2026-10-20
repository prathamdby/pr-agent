import { GitHubMark, LinkedInMark, XMark } from "@/components/icons";
import { AGENT_RESOURCES, DOC_LINKS } from "@/lib/agentResources";
import { llmsNudgeTitle } from "@/lib/llmsKnowledge";
import { LICENSE_URL, LINKEDIN_URL, REPO_URL, X_URL } from "@/lib/site";
import { PRODUCT_NAME } from "@/lib/seo";

const SOCIAL_LINKS = [
  { href: REPO_URL, label: `${PRODUCT_NAME} on GitHub`, Icon: GitHubMark },
  { href: X_URL, label: "Pratham on X", Icon: XMark },
  { href: LINKEDIN_URL, label: "Pratham on LinkedIn", Icon: LinkedInMark },
] as const;

const PRODUCT_LINKS = [
  { href: "/#features", label: "How it works" },
  { href: "/#examples", label: "Examples" },
  { href: "/#capabilities", label: "Commands" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
  { href: "/#usage", label: "Installation" },
] as const;

function shortTitle(title: string): string {
  const stripped = title.replace(new RegExp(`^${PRODUCT_NAME} `), "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

const AGENT_FILES = AGENT_RESOURCES.filter(
  (resource) => resource.inSitemap && resource.path !== "/",
);

const linkClassName =
  "inline-flex min-h-8 items-center rounded-xs text-sm text-text-secondary transition-colors duration-150 hover:text-text";

const legalLinkClassName = "hit-area rounded-xs focus-visible:outline-on-accent hover:underline";

export function UsefulShelfBadge() {
  return (
    <a
      href="https://usefulshelf.co/?utm_source=pr-agent-site.vercel.app&utm_medium=referral&utm_campaign=badge&utm_content=text"
      target="_blank"
      rel="noopener"
      className={legalLinkClassName}
    >
      Featured on UsefulShelf
    </a>
  );
}

export function Footer({ continuesSky = false }: { continuesSky?: boolean }) {
  const year = new Date().getFullYear();
  return (
    <footer className={continuesSky ? "sky-fold sky-fold-continued" : "sky-fold"}>
      <div className="container-x pt-12 pb-5 sm:pt-16 sm:pb-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-[minmax(0,4fr)_minmax(0,2fr)_minmax(0,2fr)_minmax(0,3fr)] lg:gap-12">
          <div className="col-span-2 pb-2 sm:col-span-3 lg:col-span-1 lg:pb-0">
            <a href="/" className="inline-flex items-center gap-2.5 rounded-sm text-text">
              <img
                src="/logo.png"
                alt=""
                width={28}
                height={28}
                className="size-7 rounded-sm outline-none"
              />
              <span className="text-ui font-semibold tracking-[-0.01em]">{PRODUCT_NAME}</span>
            </a>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-text-secondary lg:max-w-xs">
              AI pull request reviews on servers you run. MIT licensed, no per-seat fee, your GitHub
              credentials and model keys stay with you.
            </p>
          </div>

          <div>
            <p className="text-sm font-medium text-text">Product</p>
            <ul className="mt-2 flex flex-col">
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
            <p className="text-sm font-medium text-text">For agents</p>
            <ul className="mt-2 flex flex-col">
              {AGENT_FILES.map((resource) => (
                <li key={resource.path}>
                  <a
                    href={resource.path}
                    title={resource.description}
                    className={`${linkClassName} font-mono text-label`}
                  >
                    {resource.path}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <p className="text-sm font-medium text-text">Documentation</p>
            <ul className="mt-2 flex flex-col">
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
        </div>

        <div className="mt-24 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-t border-on-accent/40 pt-5 text-label text-on-accent sm:mt-28 lg:justify-start">
          <p className="tabular">
            © {year} {PRODUCT_NAME}. MIT licensed.
          </p>
          <span
            aria-hidden="true"
            className="hidden h-4 w-px bg-on-accent/40 lg:order-last lg:block"
          />
          <ul className="flex items-center gap-3 lg:order-last lg:gap-2.5">
            {SOCIAL_LINKS.map(({ href, label, Icon }) => (
              <li key={href}>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  title={label}
                  className="grid size-6 place-items-center rounded-xs transition-opacity duration-150 focus-visible:outline-on-accent hover:opacity-75"
                >
                  <Icon className="size-5 lg:size-4.5" />
                </a>
              </li>
            ))}
          </ul>
          <ul className="flex w-full flex-wrap items-center gap-x-5 gap-y-2 lg:ml-auto lg:w-auto lg:gap-x-6">
            <li>
              <a
                href={LICENSE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={legalLinkClassName}
              >
                License
              </a>
            </li>
            <li>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={legalLinkClassName}
              >
                GitHub
              </a>
            </li>
            <li>
              <a href="/llms.txt" title={llmsNudgeTitle()} className={legalLinkClassName}>
                llms.txt
              </a>
            </li>
            <li>
              <UsefulShelfBadge />
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
