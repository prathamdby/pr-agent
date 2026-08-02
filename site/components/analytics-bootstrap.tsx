import { useEffect } from "react";
import { initSiteAnalytics } from "@/lib/analytics";

export function AnalyticsBootstrap() {
  useEffect(() => {
    void initSiteAnalytics();
  }, []);
  return null;
}
