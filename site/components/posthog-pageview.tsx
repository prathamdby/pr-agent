import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

const PROJECT_TOKEN = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
const HOST = import.meta.env.VITE_POSTHOG_HOST?.trim() ?? "";

export function PostHogPageview() {
  const router = useRouter();

  useEffect(() => {
    if (!PROJECT_TOKEN) return;

    const cleanup = { cancelled: false, unsubscribe: undefined as undefined | (() => void) };
    void import("posthog-js").then(({ default: posthog }) => {
      if (cleanup.cancelled) return;
      if (!posthog.__loaded) {
        posthog.init(PROJECT_TOKEN, {
          ...(HOST ? { api_host: HOST } : {}),
          capture_pageview: false,
        });
      }
      const capture = () => {
        posthog.capture("$pageview");
      };
      capture();
      cleanup.unsubscribe = router.subscribe("onResolved", capture);
    });

    return () => {
      cleanup.cancelled = true;
      cleanup.unsubscribe?.();
    };
  }, [router]);

  return null;
}
