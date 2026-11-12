import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ButtonLink } from "@/components/button";
import { ChevronRight, GitHubMark, Menu, X } from "@/components/icons";
import { ThemeToggle } from "@/components/theme-toggle";
import { PRODUCT_NAME } from "@/lib/seo";
import { REPO_URL } from "@/lib/site";

const NAV = [
  { href: "/#features", label: "How it works" },
  { href: "/#examples", label: "Examples" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
] as const;

const INERT_SELECTOR = "main, .page-frame > footer";
const FOCUSABLE = "a[href], button:not([disabled])";

export function Header() {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const [stuck, setStuck] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const menu = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

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
    const covered = document.querySelectorAll(INERT_SELECTOR);
    covered.forEach((node) => node.setAttribute("inert", ""));
    const wide = matchMedia("(min-width: 48rem)");
    const onWide = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setInstant(true);
        setOpen(false);
      }
    };
    wide.addEventListener("change", onWide);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
        return;
      }
      if (event.key !== "Tab" || header.current === null || menu.current === null) {
        return;
      }
      const stops = [
        ...header.current.querySelectorAll<HTMLElement>(FOCUSABLE),
        ...menu.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter((node) => node.offsetParent !== null);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      covered.forEach((node) => node.removeAttribute("inert"));
      wide.removeEventListener("change", onWide);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

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

  const dismiss = () => {
    setInstant(false);
    setOpen(false);
  };

  return (
    <>
      <div
        ref={sentinel}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
      />
      <header
        ref={header}
        data-stuck={stuck}
        data-open={open}
        className="sticky top-0 z-40 shadow-header-edge transition-[box-shadow,background-color] duration-200 data-[stuck=true]:bg-surface/85 data-[stuck=true]:shadow-header data-[stuck=true]:backdrop-blur-md"
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
            <span className="truncate text-ui font-semibold tracking-[-0.01em]">
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
            <ThemeToggle />
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
              className="btn btn-ghost size-9 px-0 aria-expanded:bg-surface aria-expanded:text-text aria-expanded:shadow-soft md:hidden"
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
      </header>

      <div
        aria-hidden="true"
        data-open={open}
        data-instant={instant}
        className="menu-scrim md:hidden"
        onClick={dismiss}
      />
      <nav
        ref={menu}
        id="mobile-menu"
        aria-label="Primary, mobile"
        data-open={open}
        data-instant={instant}
        className="menu-panel md:hidden"
      >
        {NAV.map((item) => (
          <a key={item.href} href={item.href} onClick={closeForNavigation} className="menu-row">
            {item.label}
            <ChevronRight className="size-4 text-text-tertiary" />
          </a>
        ))}
        <div aria-hidden="true" className="mx-3 my-1.5 h-px bg-line" />
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={dismiss}
          className="menu-well"
        >
          <GitHubMark className="size-4" />
          GitHub
        </a>
      </nav>
    </>
  );
}
