import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ButtonLink } from "@/components/button";
import { ArrowUpRight, ChevronRight, GitHubMark, Menu, X } from "@/components/icons";
import { PRODUCT_NAME } from "@/lib/seo";
import { REPO_URL } from "@/lib/site";

/** Absolute hashes so the same header works from the 404 page. */
const NAV = [
  { href: "/#features", label: "How it works" },
  { href: "/#examples", label: "Examples" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
] as const;

export function Header() {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const [stuck, setStuck] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  // A hairline above the header leaves the viewport the moment the header sticks.
  useEffect(() => {
    const node = sentinel.current;
    if (node === null) {
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry !== undefined) {
        setStuck(!entry.isIntersecting);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // The panel must be gone before the browser measures the anchor it is about to scroll to.
  const closeForNavigation = () => {
    if (!open) {
      return;
    }
    flushSync(() => {
      setInstant(true);
      setOpen(false);
    });
  };

  const toggle = () => {
    setInstant(false);
    setOpen((value) => !value);
  };

  return (
    <>
      <div
        ref={sentinel}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
      />
      <header
        data-stuck={stuck}
        className="sticky top-0 z-40 bg-surface/85 backdrop-blur-md transition-[box-shadow] duration-200 data-[stuck=true]:shadow-header"
      >
        <div className="container-x flex h-16 items-center justify-between gap-4">
          <Link
            to="/"
            className="flex min-w-0 items-center gap-2.5 rounded-sm text-text"
            aria-label={`${PRODUCT_NAME} home`}
          >
            <img
              src="/logo.png"
              alt=""
              width={28}
              height={28}
              className="size-7 shrink-0 rounded-sm outline-none"
            />
            <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">
              {PRODUCT_NAME}
            </span>
          </Link>

          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} className="btn btn-ghost h-9 px-3 font-normal">
                {item.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-leading hidden h-9 font-normal sm:inline-flex"
            >
              <GitHubMark className="size-4" />
              <span>GitHub</span>
            </a>
            <ButtonLink
              href="/#usage"
              className="h-9"
              trailingIcon={<ChevronRight className="size-4" />}
              onClick={closeForNavigation}
            >
              Deploy
            </ButtonLink>
            <button
              ref={menuButton}
              type="button"
              className="btn btn-ghost size-9 px-0 md:hidden"
              aria-expanded={open}
              aria-controls="mobile-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={toggle}
            >
              <span className="swap size-5" aria-hidden="true">
                <span data-shown={!open} className="grid place-items-center">
                  <Menu className="size-5" />
                </span>
                <span data-shown={open} className="grid place-items-center">
                  <X className="size-5" />
                </span>
              </span>
            </button>
          </div>
        </div>

        <div
          id="mobile-menu"
          data-open={open}
          data-instant={instant}
          className="menu-panel border-t border-line md:hidden"
        >
          <nav aria-label="Primary, mobile" className="container-x flex flex-col py-3">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={closeForNavigation}
                className="flex h-11 items-center rounded-sm px-3 text-[15px] text-text hover:bg-surface-hover"
              >
                {item.label}
              </a>
            ))}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex h-11 items-center gap-2 rounded-sm px-3 text-[15px] text-text hover:bg-surface-hover"
            >
              <GitHubMark className="size-4" />
              GitHub
              <ArrowUpRight className="size-3.5 text-text-tertiary" />
            </a>
          </nav>
        </div>
      </header>
    </>
  );
}
