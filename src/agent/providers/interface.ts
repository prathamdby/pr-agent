import type { JsonObject, JsonValue } from "../../util/jsonValue.js";
import type { AgentRunnerTurn } from "./usageMetadata.js";

export type { AgentRunnerTurn };

export type AgentRunnerToolExecutor = (args: JsonObject) => Promise<JsonValue>;

export type AgentRunnerToolExecutorMap = {
  readonly [name: string]: AgentRunnerToolExecutor;
};
