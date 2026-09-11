import { InMemoryCredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import { overlayCatalog } from "../../settings/modelsJson.js";

export type SessionModels = {
  readonly models: MutableModels;
  readonly credentials: InMemoryCredentialStore;
};

export async function createSessionModels(cfg: Config): Promise<SessionModels> {
  const credentials = new InMemoryCredentialStore();
  const models = await overlayCatalog(cfg.modelsJsonPath, credentials);
  for (const [provider, key] of Object.entries(cfg.modelProviderKeys)) {
    if (key.trim()) {
      await credentials.modify(provider, async () => ({ type: "api_key", key: key.trim() }));
    }
  }
  return { models, credentials };
}
