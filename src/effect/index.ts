import type { Config } from "../config.js";
import { startEffectWebhookServer } from "./server.js";

export function mainEffectApp(cfg: Config): void {
  startEffectWebhookServer(cfg);
}
