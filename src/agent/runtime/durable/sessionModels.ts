import { InMemoryCredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import type { Config } from "../../../settings/index.ts";
import { overlayCatalog } from "./modelsJson.ts";

export type SessionModels = {
  readonly models: MutableModels;
  readonly credentials: InMemoryCredentialStore;
};

export async function createSessionModels(cfg: Config) {
  const credentials = new InMemoryCredentialStore();
  const models = await overlayCatalog(cfg.models.jsonPath, credentials);
  for (const [provider, key] of Object.entries(cfg.models.providerKeys)) {
    if (key.trim()) {
      await credentials.modify(provider, async () => ({ type: "api_key", key: key.trim() }));
    }
  }
  return ((pinnedReturn: SessionModels | Promise<SessionModels>) => pinnedReturn)({
    models,
    credentials,
  });
}
