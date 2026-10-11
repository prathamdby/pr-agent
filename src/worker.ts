import { Layer } from "effect";
import type { Config } from "./settings/index.js";
import { agentWorkWorkerLive } from "./agentWork/worker.js";

export function startAgentWorker(cfg: Config) {
  return Layer.launch(agentWorkWorkerLive(cfg));
}
