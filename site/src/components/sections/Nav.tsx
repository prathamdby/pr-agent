import { useEffect, useState } from "react";
import { GithubLogo } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Mark } from "@/components/Mark";
import { NAV_LINKS, GITHUB_URL } from "@/content";
import { cn } from "@/lib/utils";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

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
          "flex h-16 w-full max-w-[1180px] items-center justify-between rounded-full border px-4 transition-all duration-300 sm:px-5",
          scrolled
            ? "border-border-hi bg-bg-soft/85 backdrop-blur-xl"
            : "border-transparent bg-transparent",
        )}
      >
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
          <Button asChild size="sm">
            <a href="#start">Get started</a>
          </Button>
        </div>
      </nav>
    </header>
  );
}
