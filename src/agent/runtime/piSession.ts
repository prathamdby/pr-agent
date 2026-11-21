import { createDurablePiSession } from "./durable/session.ts";
import { getSharedDurableRuntime } from "./durable/runtime.ts";
import type { PiSession, PiSessionCreateParams } from "./types.ts";

export type { PiSession, PiSessionCreateParams } from "./types.ts";
export { DEFAULT_THINKING_POLICY, DEFAULT_TOOL_POLICY } from "./types.ts";
export { createFakePiSession } from "./fakePiSession.ts";
export type { FakePiSessionControls, FakePiSessionScript } from "./fakePiSession.ts";
export { compactionPolicyForRole } from "./compactionPolicy.ts";
export {
  DEFAULT_PROMPT_CACHE_POLICY,
  SESSION_CACHE_ID_MAX_LENGTH,
  cacheIdentityFromAssignment,
  sessionCacheIdFromIdentity,
  specialistSharedCacheId,
} from "./promptCachePolicy.ts";
export type {
  AgentSessionCacheIdentity,
  PromptCachePolicy,
  PromptCacheRetention,
} from "./promptCachePolicy.ts";

export async function createPiSession(params: PiSessionCreateParams) {
  const runtime = await getSharedDurableRuntime(params.cfg);
  return ((pinnedReturn: PiSession | Promise<PiSession>) => pinnedReturn)(
    createDurablePiSession({ ...params, runtime }),
  );
}
