import { initNoOpAnalytics } from "../../src/analytics/index.ts";
import { initEvlog } from "../../src/evlog.ts";

initEvlog("error", { silent: true, suppressDrainWarning: true });
initNoOpAnalytics();
