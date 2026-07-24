import { createFakePiSession } from "./fakePiSession.js";
import { createPiSessionImpl } from "./piSessionImpl.js";
import type { PiSession, PiSessionCreateParams } from "./types.js";

export type { PiSession, PiSessionCreateParams } from "./types.js";
export {
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
} from "./types.js";
export { createFakePiSession } from "./fakePiSession.js";
export type { FakePiSessionControls, FakePiSessionScript } from "./fakePiSession.js";

/** Production factory for the Pi-specific session seam. */
export async function createPiSession(params: PiSessionCreateParams): Promise<PiSession> {
  return createPiSessionImpl(params);
}

/** Test helper that returns a controllable fake session without touching the SDK. */
export function createTestPiSession(params: PiSessionCreateParams) {
  return createFakePiSession(params);
}
