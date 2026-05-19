import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import type { Config } from "./config.js";
import { AgentWorkerRuntimeLive } from "./agentWork/runtime.js";

export function startAgentWorker(cfg: Config): void {
	NodeRuntime.runMain(Layer.launch(AgentWorkerRuntimeLive(cfg)));
}

