import { ListIcon, XIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { ButtonLink } from "@/components/ui/button";
import { GithubMark } from "@/components/ui/github-mark";
import { IconSwap } from "@/components/ui/icon-swap";
import { PRODUCT_NAME } from "@/lib/seo";
import { DOCS_URL, REPO_URL } from "@/lib/site";

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#examples", label: "Examples" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
  { href: DOCS_URL, label: "Docs", external: true },
] as const;

function NavLink({
  href,
  label,
  external = false,
  onClick,
}: {
  readonly href: string;
  readonly label: string;
  readonly external?: boolean;
  readonly onClick?: () => void;
}) {
  const className =
    "link-muted rounded-control px-3 py-2 text-sm font-medium text-fg-muted transition-colors duration-150";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {label}
      </a>
    );
  }
  return (
    <a href={href} className={className} onClick={onClick}>
      {label}
    </a>
  );
}

export function Header() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  return (
    <header className="glass sticky top-0 z-(--z-nav) border-b border-line">
      <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between gap-4 px-5 sm:px-8">
        <Link
          to="/"
          className="flex min-w-0 items-center gap-2.5 rounded-control"
          aria-label={`${PRODUCT_NAME} home`}
        >
          <img
            src="/logo.png"
            alt=""
            width={28}
            height={28}
            className="size-7 shrink-0 rounded-[7px]"
          />
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">
            {PRODUCT_NAME}
          </span>
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-0.5 lg:flex">
          {NAV.map((item) => (
            <NavLink key={item.label} {...item} />
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="PR Agent on GitHub"
            className="press link-muted grid size-10 place-items-center rounded-control text-fg-muted transition-[background-color,color] duration-150 ease-out hover:bg-well"
          >
            <GithubMark className="size-5" />
          </a>
          <ButtonLink href="#install">Deploy</ButtonLink>
        </div>

        <button
          type="button"
          className="press grid size-10 place-items-center rounded-control text-fg lg:hidden"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((value) => !value)}
        >
          <IconSwap state={open ? "open" : "closed"}>
            {open ? <XIcon className="size-5" /> : <ListIcon className="size-5" />}
          </IconSwap>
        </button>
      </div>

      <div
        id={menuId}
        hidden={!open}
        className="menu-sheet border-t border-line bg-canvas px-5 pb-5 pt-2 lg:hidden"
      >
        <nav aria-label="Primary, mobile" className="flex flex-col">
          {NAV.map((item) => (
            <NavLink key={item.label} {...item} onClick={() => setOpen(false)} />
          ))}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="link-muted rounded-control px-3 py-2 text-sm font-medium text-fg-muted"
          >
            GitHub
          </a>
        </nav>
        <div className="mt-3 px-3">
          <ButtonLink href="#install" className="w-full justify-center">
            Deploy
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}
