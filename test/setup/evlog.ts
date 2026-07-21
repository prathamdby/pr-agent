import { initNoOpAnalytics } from "../../src/analytics/index.js";
import { initEvlog } from "../../src/evlog.js";

initEvlog("error", { silent: true, suppressDrainWarning: true });
initNoOpAnalytics();
