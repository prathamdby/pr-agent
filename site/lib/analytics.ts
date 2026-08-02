/**
 * Optional site analytics via the PostHog browser snippet.
 * On when `VITE_PUBLIC_POSTHOG_KEY` is set at build time; off otherwise.
 */

type PostHogStub = {
  init: (key: string, options: Record<string, unknown>) => void;
};

function readViteEnv(name: string): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
  return (env?.[name] ?? "").trim();
}

/** Load PostHog when a public key is present. No-op when the key is empty or not in a browser. */
export async function initSiteAnalytics(): Promise<void> {
  const key = readViteEnv("VITE_PUBLIC_POSTHOG_KEY");
  if (!key || typeof document === "undefined") return;

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
    if (!ph) return;

    const host = readViteEnv("VITE_PUBLIC_POSTHOG_HOST") || "https://us.i.posthog.com";
    ph.init(key, {
      api_host: host,
      persistence: "localStorage+cookie",
      autocapture: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
      },
    });
  } catch {
    // ignore load/init failures; analytics is optional
  }
}
