import { useEffect } from "react";

/**
 * A colour-scheme flip changes colour, background, border and shadow on nearly every element
 * at once. Turning every transition off for that one frame makes the switch snap instead of
 * smearing. The reflow read forces the new colours to commit while the override is in place.
 */
export function DisableThemeTransitions() {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const style = document.createElement("style");
      style.append(document.createTextNode("*,*::before,*::after{transition:none !important}"));
      document.head.append(style);
      void document.body.offsetHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => style.remove());
      });
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return null;
}
