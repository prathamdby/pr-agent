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

export const REPO_URL = "https://github.com/prathamdby/pr-agent";
export const DOCS_URL = `${REPO_URL}#host-with-docker-compose`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
