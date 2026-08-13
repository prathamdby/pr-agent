import { createPiSessionImpl } from "./piSessionImpl.js";
import type { PiSession, PiSessionCreateParams } from "./types.js";

export type { PiSession, PiSessionCreateParams } from "./types.js";
export { DEFAULT_THINKING_POLICY, DEFAULT_TOOL_POLICY, EMPTY_STRUCTURED_STATE } from "./types.js";
export { createFakePiSession } from "./fakePiSession.js";
export { resetPiSessionRuntime, setPiSessionRuntime } from "./piSessionImpl.js";
export type {
  PiDefinedTool,
  PiDefineToolInput,
  PiModelInfo,
  PiModelRuntime,
  PiSdkEvent,
  PiSdkSession,
  PiSdkTurnEndEvent,
  PiSessionRuntime,
  PiToolExecuteContext,
} from "./piSessionImpl.js";
export type { FakePiSessionControls, FakePiSessionScript } from "./fakePiSession.js";
export { compactionPolicyForRole } from "./compactionPolicy.js";
export {
  DEFAULT_PROMPT_CACHE_POLICY,
  SESSION_CACHE_ID_MAX_LENGTH,
  cacheIdentityFromAssignment,
  sessionCacheIdFromIdentity,
} from "./promptCachePolicy.js";
export type {
  AgentSessionCacheIdentity,
  PromptCachePolicy,
  PromptCacheRetention,
} from "./promptCachePolicy.js";

type CreatePiSession = typeof createPiSessionImpl;

let activeCreatePiSession: CreatePiSession = createPiSessionImpl;

export function setCreatePiSession(create: CreatePiSession): void {
  activeCreatePiSession = create;
}

export function resetCreatePiSession(): void {
  activeCreatePiSession = createPiSessionImpl;
}

/** Production factory for the Pi-specific session seam. */
export async function createPiSession(params: PiSessionCreateParams): Promise<PiSession> {
  return activeCreatePiSession(params);
}
