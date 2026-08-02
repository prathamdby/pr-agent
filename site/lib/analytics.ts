/** Optional site analytics via PostHog CDN snippet when PUBLIC_POSTHOG_KEY is set. */

export type SiteAnalytics = {
  readonly capture: (event: string, properties?: Record<string, unknown>) => void;
  readonly shutdown: () => void;
};

type PostHogStub = {
  capture: (event: string, properties?: Record<string, unknown>) => void;
  reset: () => void;
  init: (key: string, options: Record<string, unknown>) => void;
};

const noop: SiteAnalytics = {
  capture() {},
  shutdown() {},
};

let instance: SiteAnalytics = noop;

function readPublicKey(): string {
  const viteKey =
    (typeof import.meta !== "undefined" &&
      (import.meta as ImportMeta & { env?: Record<string, string> }).env
        ?.VITE_PUBLIC_POSTHOG_KEY) ||
    "";
  const processKey =
    typeof process !== "undefined"
      ? (process.env.PUBLIC_POSTHOG_KEY ?? process.env.VITE_PUBLIC_POSTHOG_KEY ?? "")
      : "";
  return (viteKey || processKey).trim();
}

function readHost(): string {
  const viteHost =
    (typeof import.meta !== "undefined" &&
      (import.meta as ImportMeta & { env?: Record<string, string> }).env
        ?.VITE_PUBLIC_POSTHOG_HOST) ||
    "";
  const processHost =
    typeof process !== "undefined"
      ? (process.env.PUBLIC_POSTHOG_HOST ?? process.env.VITE_PUBLIC_POSTHOG_HOST ?? "")
      : "";
  return (viteHost || processHost || "https://us.i.posthog.com").trim();
}

export async function initSiteAnalytics(): Promise<SiteAnalytics> {
  const key = readPublicKey();
  if (!key || typeof document === "undefined") {
    instance = noop;
    return instance;
  }

  try {
    const w = window as Window & { posthog?: PostHogStub };
    if (!w.posthog) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.async = true;
        script.src = "https://us-assets.i.posthog.com/static/array.js";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("posthog snippet failed to load"));
        document.head.appendChild(script);
      });
    }

    const ph = (window as Window & { posthog?: PostHogStub }).posthog;
    if (!ph) {
      instance = noop;
      return instance;
    }

    ph.init(key, {
      api_host: readHost(),
      persistence: "localStorage+cookie",
      autocapture: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
      },
    });

    instance = {
      capture(event, properties) {
        ph.capture(event, properties);
      },
      shutdown() {
        ph.reset();
      },
    };
  } catch {
    instance = noop;
  }
  return instance;
}

export function getSiteAnalytics(): SiteAnalytics {
  return instance;
}

export function isSiteAnalyticsEnabled(): boolean {
  return Boolean(readPublicKey());
}
