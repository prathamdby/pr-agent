/// <reference types="node" />

function resolveSiteOrigin(): string {
  const explicit = process.env.SITE_ORIGIN?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) {
    return `https://${production}`;
  }

  const preview = process.env.VERCEL_URL?.trim();
  if (preview) {
    return `https://${preview}`;
  }

  return "http://localhost:3000";
}

/** Resolved at build time on Vercel. Override with SITE_ORIGIN for a custom domain. */
export const SITE_ORIGIN = resolveSiteOrigin();

function trustedDiscoveryHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  return host === "vercel.app" || host.endsWith(".vercel.app");
}

/**
 * Origin discovery documents may name.
 * Localhost and Vercel preview hosts are trusted. Any other host, including one
 * that fails to parse, falls back to the build origin so a forged Host is not
 * written into a cached sitemap or catalog. Canonical and OpenAPI stay on the
 * build origin.
 */
export function requestOrigin(request: Request): string {
  try {
    const origin = new URL(request.url).origin;
    if (origin === SITE_ORIGIN) {
      return origin;
    }
    if (trustedDiscoveryHost(new URL(origin).hostname)) {
      return origin;
    }
  } catch {
    return SITE_ORIGIN;
  }
  return SITE_ORIGIN;
}

export const REPO_URL = "https://github.com/prathamdby/pr-agent";
export const DOCS_URL = `${REPO_URL}#installation`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const X_URL = "https://x.com/prathamdby";
export const LINKEDIN_URL = "https://www.linkedin.com/in/prathamdby";
