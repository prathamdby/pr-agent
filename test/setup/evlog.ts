import { initEvlog } from "../../src/evlog.js";
import { initNoOpPostHog } from "../../src/posthog.js";

initEvlog("error", { silent: true, suppressDrainWarning: true });
initNoOpPostHog();
