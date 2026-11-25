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
    host === "vercel.app" || host.endsWith(".vercel.app"),
  );
}

type PageOriginBinding = {
  getStore(): string | undefined;
};

let pageOriginBinding: PageOriginBinding | undefined;

export function bindPageOrigin(binding: PageOriginBinding) {
  pageOriginBinding = binding;
}

function browserHref() {
  const href = (globalThis as { window?: { location?: { href?: unknown } } }).window?.location
    ?.href;
  if (typeof href !== "string" || href.length === 0) {
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(href);
}

export function pageOrigin() {
  const href = browserHref();
  if (href !== undefined) {
    try {
      return requestOrigin(new Request(href));
    } catch {
      return ((pinnedReturn: string) => pinnedReturn)(SITE_ORIGIN);
    }
  }
  return ((pinnedReturn: string) => pinnedReturn)(pageOriginBinding?.getStore() ?? SITE_ORIGIN);
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
