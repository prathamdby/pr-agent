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

function trustedDiscoveryHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(
    host === "vercel.app" || host.endsWith(".vercel.app"),
  );
}

export function requestOrigin(request: Request) {
  try {
    const origin = new URL(request.url).origin;
    if (origin === SITE_ORIGIN) {
      return ((pinnedReturn: string) => pinnedReturn)(origin);
    }
    if (trustedDiscoveryHost(new URL(origin).hostname)) {
      return ((pinnedReturn: string) => pinnedReturn)(origin);
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
