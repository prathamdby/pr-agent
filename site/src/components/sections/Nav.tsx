import { useEffect, useState } from "react";
import { GithubLogo, List, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Mark } from "@/components/Mark";
import { NAV_LINKS, GITHUB_URL } from "@/content";
import { cn } from "@/lib/utils";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-3">
      <nav
        className={cn(
          "w-full max-w-[1180px] rounded-[1.4rem] border px-4 transition-all duration-300 sm:px-5",
          scrolled || open
            ? "border-line-hi bg-bg-soft/90 backdrop-blur-xl"
            : "border-transparent bg-transparent",
        )}
      >
        <div className="flex h-16 items-center justify-between">
          <a href="#top" className="flex items-center" aria-label="PR Agent, back to top">
            <Mark />
          </a>

          <div className="hidden items-center gap-1 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-full px-3.5 py-2 text-sm text-fg-muted transition-colors hover:text-fg"
              >
                {link.label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                <GithubLogo size={18} weight="fill" />
                GitHub
              </a>
            </Button>
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <a href="#start">Get started</a>
            </Button>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              className="flex size-10 items-center justify-center rounded-full text-fg-muted hover:text-fg md:hidden"
            >
              {open ? <X size={20} /> : <List size={20} />}
            </button>
          </div>
        </div>

        {open && (
          <div className="flex flex-col gap-1 border-t border-line pb-3 pt-2 md:hidden">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm text-fg-muted hover:bg-surface hover:text-fg"
              >
                {link.label}
              </a>
            ))}
            <Button asChild size="sm" className="mt-2">
              <a href="#start" onClick={() => setOpen(false)}>
                Get started
              </a>
            </Button>
          </div>
        )}
      </nav>
    </header>
  );
}
