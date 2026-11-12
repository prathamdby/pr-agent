export const THEME_STORAGE_KEY = "theme";

export type Theme = "light" | "dark";

export const THEME_CHROME: Record<Theme, string> = {
  light: "#ffffff",
  dark: "#0b111c",
};

export function renderThemeScript(): string {
  return `(function () {
  var theme;
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    theme = stored === "light" || stored === "dark" ? stored : null;
  } catch (error) {
    theme = null;
  }
  if (theme === null) {
    theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
  var chrome = document.querySelector('meta[name="theme-color"]');
  if (chrome) chrome.setAttribute("content", ${JSON.stringify(THEME_CHROME)}[theme]);
})();`;
}
