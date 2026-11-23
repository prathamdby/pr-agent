/// <reference types="node" />

function resolveSiteOrigin() {
  const explicit = process.env.SITE_ORIGIN?.trim();
  if (explicit) {
    return ((pinnedReturn: string) => pinnedReturn)(explicit.replace(/\/$/, ""));
  }

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) {
    return ((pinnedReturn: string) => pinnedReturn)(`https://${production}`);
  }

  const preview = process.env.VERCEL_URL?.trim();
  if (preview) {
    return ((pinnedReturn: string) => pinnedReturn)(`https://${preview}`);
  }

  return ((pinnedReturn: string) => pinnedReturn)("http://localhost:3000");
}

export const SITE_ORIGIN = resolveSiteOrigin();

function loopbackHost(hostname: string) {
  const host = hostname.toLowerCase();
  return ((pinnedReturn: boolean) => pinnedReturn)(
    host === "localhost" || host === "127.0.0.1" || host === "[::1]",
  );
}

function trustedDiscoveryHost(hostname: string) {
  const host = hostname.toLowerCase();
  return ((pinnedReturn: boolean) => pinnedReturn)(
    loopbackHost(host) || host === "vercel.app" || host.endsWith(".vercel.app"),
  );
}

type PageWindow = {
  readonly location: { readonly origin: string };
  readonly document: {
    querySelector(selector: string): { readonly href?: string } | null;
  };
};

declare const window: PageWindow | undefined;

export function pageOrigin() {
  if (typeof window === "undefined") {
    return ((pinnedReturn: string) => pinnedReturn)(SITE_ORIGIN);
  }
  const href =
    window.document.querySelector('link[rel="canonical"]')?.href ?? window.location.origin;
  try {
    return ((pinnedReturn: string) => pinnedReturn)(new URL(href).origin);
  } catch {
    return ((pinnedReturn: string) => pinnedReturn)(window.location.origin);
  }
}

export function requestOrigin(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.origin === SITE_ORIGIN) {
      return ((pinnedReturn: string) => pinnedReturn)(SITE_ORIGIN);
    }
    if (loopbackHost(url.hostname)) {
      return ((pinnedReturn: string) => pinnedReturn)(url.origin);
    }
    if (trustedDiscoveryHost(url.hostname)) {
      return ((pinnedReturn: string) => pinnedReturn)(`https://${url.host}`);
    }
  } catch {
    return ((pinnedReturn: string) => pinnedReturn)(SITE_ORIGIN);
  }
  return ((pinnedReturn: string) => pinnedReturn)(SITE_ORIGIN);
}

export const REPO_URL = "https://github.com/prathamdby/pr-agent";
export const DOCS_URL = `${REPO_URL}#installation`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const X_URL = "https://x.com/prathamdby";
export const LINKEDIN_URL = "https://www.linkedin.com/in/prathamdby";
