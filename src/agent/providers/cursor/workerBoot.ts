import type { Config } from "../../../config.js";
import {
  getCursorCatalogItems,
  getFastParamModelIds,
  initCursorModelCapabilities,
} from "./modelCapabilities.js";
import {
  assertCursorModelFastSelection,
  assertCursorModelId,
  listTopCursorModelIds,
} from "./models.js";
import { registerCursorProvider } from "./register.js";

export type CursorWorkerBootInfo = {
  readonly modelCount: number;
  readonly topModels: readonly string[];
  readonly fastModels: readonly string[];
};

export async function initCursorWorker(
  cfg: Pick<Config, "cursorApiKey" | "piModel">,
): Promise<CursorWorkerBootInfo> {
  await initCursorModelCapabilities(cfg.cursorApiKey);
  assertCursorModelId(cfg.piModel);
  assertCursorModelFastSelection(cfg.piModel);
  registerCursorProvider();
  return {
    modelCount: getCursorCatalogItems().length,
    topModels: listTopCursorModelIds(10),
    fastModels: [...getFastParamModelIds()],
  };
}
