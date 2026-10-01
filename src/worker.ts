import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Layer } from "effect";
import type { Config } from "./config.js";
import { agentWorkWorkerLive } from "./agentWork/worker.js";

export function startAgentWorker(cfg: Config): void {
  NodeRuntime.runMain(Layer.launch(agentWorkWorkerLive(cfg)));
}
