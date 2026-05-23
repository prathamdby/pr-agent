import { vi } from "vitest";

class MockCursorAgentError extends Error {
  readonly isRetryable: boolean;
  constructor(message: string, isRetryable = false) {
    super(message);
    this.name = "CursorAgentError";
    this.isRetryable = isRetryable;
  }
}

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
  },
  CursorAgentError: MockCursorAgentError,
}));
