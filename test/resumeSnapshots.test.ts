import { describe, expect, it } from "vitest";
import { isAppError } from "../src/errors/appError.js";
import {
  computeResumeSnapshotTtlSeconds,
  decryptResumeSnapshot,
  encryptResumeSnapshot,
  RESUME_SNAPSHOT_ENVELOPE_VERSION,
} from "../src/agent/runtime/resumeSnapshots.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

function meta(overrides: Record<string, unknown> = {}) {
  return {
    envelopeVersion: RESUME_SNAPSHOT_ENVELOPE_VERSION,
    installationId: 42,
    workItemId: "11111111-1111-1111-1111-111111111111",
    sessionRole: "orchestrator" as const,
    model: { provider: "openai", model: "gpt-4o-mini" },
    sdkVersion: "pi-0.80.10",
    promptVersion: "p1",
    toolPolicyVersion: "t1",
    checkpointId: "cp-1",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("resumeSnapshots", () => {
  it("round-trips authenticated encryption", () => {
    const encrypted = encryptResumeSnapshot({
      keyMaterial: KEY,
      meta: meta(),
      plaintext: {
        conversation: { turns: 2 },
        structuredState: { version: 1, payload: { ok: true } },
      },
    });
    const plaintext = decryptResumeSnapshot({ keyMaterial: KEY, envelope: encrypted });
    expect(plaintext.conversation).toEqual({ turns: 2 });
    expect(plaintext.structuredState).toEqual({ version: 1, payload: { ok: true } });
  });

  it("enforces tenant isolation via AAD/key derivation", () => {
    const encrypted = encryptResumeSnapshot({
      keyMaterial: KEY,
      meta: meta({ installationId: 1 }),
      plaintext: { conversation: {}, structuredState: {} },
    });
    const tampered = { ...encrypted, installationId: 2 };
    expect(() => decryptResumeSnapshot({ keyMaterial: KEY, envelope: tampered })).toThrow(
      /authentication failed|expired|version/,
    );
  });

  it("rejects expiry, version mismatch, and wrong keys", () => {
    const encrypted = encryptResumeSnapshot({
      keyMaterial: KEY,
      meta: meta({ expiresAt: new Date(Date.now() - 1000) }),
      plaintext: { conversation: {}, structuredState: {} },
    });
    expect(() => decryptResumeSnapshot({ keyMaterial: KEY, envelope: encrypted })).toThrow(
      /expired/,
    );

    const fresh = encryptResumeSnapshot({
      keyMaterial: KEY,
      meta: meta(),
      plaintext: { conversation: { a: 1 }, structuredState: {} },
    });
    expect(() =>
      decryptResumeSnapshot({
        keyMaterial: KEY,
        envelope: { ...fresh, envelopeVersion: 99 },
      }),
    ).toThrow(/version/);

    expect(() => decryptResumeSnapshot({ keyMaterial: OTHER_KEY, envelope: fresh })).toThrow(
      /authentication failed/,
    );
  });

  it("derives TTL from queue retry window, job expire, and margin", () => {
    expect(
      computeResumeSnapshotTtlSeconds({
        queueRetryLimit: 3,
        queueRetryDelayMaxSeconds: 300,
        queueExpireInSeconds: 3600,
        marginSeconds: 600,
      }),
    ).toBe(3 * 300 + 3600 + 600);
  });

  it("requires 32-byte base64 key material", () => {
    try {
      encryptResumeSnapshot({
        keyMaterial: "short",
        meta: meta(),
        plaintext: { conversation: {}, structuredState: {} },
      });
      expect.fail("expected throw");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
    }
  });
});
