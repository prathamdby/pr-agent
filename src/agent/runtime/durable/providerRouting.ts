import {
  type ConversationInit,
  GenerationTask,
  hook,
  ProviderDoc,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { splitAnthropicSystemBlocks } from "../promptCachePolicy.ts";

export { overlayCatalog, assertPiModelSelection } from "./modelsJson.ts";
export { createSessionModels, type SessionModels } from "./sessionModels.ts";
export { createRegistry } from "@earendil-works/pi-durable";

export type ProviderRoutingState = {
  readonly sharedHeadByConversation: ReadonlyMap<ConversationId, string>;
};

export function providerSessionIdInit(sessionId: string) {
  return ((pinnedReturn: ConversationInit) => pinnedReturn)(async (tx, conversationId) => {
    const doc = await tx.doc(ProviderDoc, conversationId);
    doc.sessionId = sessionId;
  });
}

export function createProviderRoutingHooks(
  sharedHeadByConversation: ReadonlyMap<ConversationId, string>,
) {
  return hook(GenerationTask, {
    beforeProviderRequest: ({ model, payload }, api) => {
      if (model.api !== "anthropic-messages") return undefined;
      const sharedHead = sharedHeadByConversation.get(api.conversationId);
      if (sharedHead == null || sharedHead.length === 0) return undefined;
      return ((pinnedReturn: { payload: unknown } | undefined) => pinnedReturn)({
        payload: splitAnthropicSystemBlocks(payload, sharedHead),
      });
    },
  });
}
