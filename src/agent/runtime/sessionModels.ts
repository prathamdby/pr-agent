import { InMemoryCredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import type { Config } from "../../settings/index.js";
import { overlayCatalog } from "./modelsJson.js";

export type SessionModels = {
  readonly models: MutableModels;
  readonly credentials: InMemoryCredentialStore;
};

export async function createSessionModels(cfg: Config): Promise<SessionModels> {
  const credentials = new InMemoryCredentialStore();
  const models = await overlayCatalog(cfg.models.jsonPath, credentials);
  for (const [provider, key] of Object.entries(cfg.models.providerKeys)) {
    if (key.trim()) {
      await credentials.modify(provider, async () => ({ type: "api_key", key: key.trim() }));
    }
  }
  return { models, credentials };
}
