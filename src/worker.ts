import { Layer } from "effect";
import type { Config } from "./settings/index.ts";
import { agentWorkWorkerLive } from "./agentWork/worker.ts";

export function startAgentWorker(cfg: Config) {
  return Layer.launch(agentWorkWorkerLive(cfg));
}
