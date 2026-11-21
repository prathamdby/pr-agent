import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../../../settings/index.ts";
import type { InstallationSurface } from "../../../agentWork/installationSurface.ts";
import type { createFeaturePiSession } from "../createFeatureSession.ts";
import type { DurableRuntime } from "./runtime.ts";

export type WorkerDeps = {
  readonly db: DatabaseSync;
  readonly runtime: DurableRuntime;
  readonly cfg: Config;
  readonly installationSurface: InstallationSurface;
  readonly createSession?: typeof createFeaturePiSession;
  readonly shutdownRequested: () => boolean;
  readonly now?: () => number;
};
