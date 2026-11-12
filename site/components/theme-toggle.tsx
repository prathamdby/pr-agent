import { useSyncExternalStore } from "react";
import { Moon, Sun } from "@/components/icons";
import { THEME_CHROME, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function readStored(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

function paint(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_CHROME[theme]);
}

function subscribe(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const system = matchMedia("(prefers-color-scheme: dark)");
  const follow = (event: MediaQueryListEvent) => {
    if (readStored() === null) {
      paint(event.matches ? "dark" : "light");
    }
  };
  system.addEventListener("change", follow);
  return () => {
    observer.disconnect();
    system.removeEventListener("change", follow);
  };
}

function choose(next: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    paint(next);
    return;
  }
  if (readTheme() === next) {
    return;
  }
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || typeof document.startViewTransition !== "function") {
    paint(next);
    return;
  }
  document.startViewTransition(() => paint(next));
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "light" as const);
  return (
    <div role="group" aria-label="Theme" className="theme-toggle">
      <span aria-hidden="true" className="theme-thumb" />
      <button
        type="button"
        data-slot="sun"
        aria-label="Light theme"
        aria-pressed={theme === "light"}
        className="theme-slot"
        onClick={() => choose("light")}
      >
        <Sun className="size-4" />
      </button>
      <button
        type="button"
        data-slot="moon"
        aria-label="Dark theme"
        aria-pressed={theme === "dark"}
        className="theme-slot"
        onClick={() => choose("dark")}
      >
        <Moon className="size-4" />
      </button>
    </div>
  );
}
